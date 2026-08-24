import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import type mqtt from 'mqtt';

import { MowerAccessory, type SensorOptions } from './mower/accessory.js';
import { ACTION_LABELS, isOk, type MowerAction, remotePbParams } from './mower/commands.js';
import { type DerivedState, type Dps, deriveMowerState, describeAttention, describeMowState } from './mower/state.js';
import { findMowers, type MowerDevice } from './roborock/mower.js';
import { RoborockMqtt } from './roborock/mqtt-client.js';
import { type PlatformStatus, readSession, type StatusDevice, writeStatus } from './roborock/session-store.js';
import { type HomeData, RoborockApiError, type StoredSession } from './roborock/types.js';
import { RoborockWebApi } from './roborock/web-api.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export interface RoborockMowerConfig extends PlatformConfig {
  pollInterval?: number;
  exposeDocked?: boolean;
  exposeLeaving?: boolean;
  exposeMowing?: boolean;
  exposeReturning?: boolean;
  exposeAttention?: boolean;
  exposeBattery?: boolean;
  faultIndicator?: boolean;
  exposeControls?: boolean;
  sensorDebounceSeconds?: number;
}

// Seams for tests; Homebridge itself never passes these.
export interface PlatformDeps {
  fetch?: typeof globalThis.fetch;
  readSession?: (storagePath: string) => Promise<StoredSession | undefined>;
  connectMqtt?: typeof mqtt.connect;
  now?: () => number;
}

// What we remember about a mower in Homebridge's accessory cache, so live updates work even when the cloud is down at boot.
interface CachedDevice {
  duid: string;
  name: string;
  model: string;
  productName?: string;
  localKey?: string;
  sn?: string;
  fv?: string;
  pv?: string;
}

interface MowerContext {
  device?: CachedDevice;
}

interface TrackedMower {
  device: CachedDevice;
  online: boolean;
  platformAccessory: PlatformAccessory;
  accessory: MowerAccessory;
  dps: Dps;
  last?: DerivedState;
  lastPushAt?: number;
}

const MIN_POLL_SECONDS = 900; // Roborock rate-limits home data; python-roborock budgets 5/hour.
const MAX_POLL_SECONDS = 86_400;
const DEFAULT_POLL_SECONDS = 3600;
const STARTUP_RETRY_MS = 5 * 60_000;
const STALE_PUSH_MS = 5 * 60_000; // a push this old no longer outranks a disagreeing cloud snapshot
const SESSION_EXPIRED = 'session-expired';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Config edited by hand bypasses the schema; never let a bad value become NaN timers.
function numberOption(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function toCached(device: MowerDevice): CachedDevice {
  const { duid, name, model, productName, localKey, sn, fv, pv } = device;
  return { duid, name, model, productName, localKey, sn, fv, pv };
}

function toNumericDps(update: Record<string | number, unknown>): Dps {
  return Object.fromEntries(Object.entries(update).map(([key, value]) => [Number(key), value]));
}

function isSessionExpired(error: unknown): boolean {
  return error instanceof RoborockApiError && error.kind === 'session-expired';
}

export class RoborockMowerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly pluginConfig: RoborockMowerConfig;

  private webApi?: RoborockWebApi;
  private mqtt?: RoborockMqtt;
  private homeId?: number;
  private session?: StoredSession;
  private reconcileTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private startPromise?: Promise<void>;
  private stopped = false;
  private sessionExpiredLogged = false;
  private readonly mowers = new Map<string, TrackedMower>();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
    private readonly deps: PlatformDeps = {},
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.pluginConfig = config as RoborockMowerConfig;

    this.api.on('didFinishLaunching', () => {
      this.startPromise = this.start();
    });
    this.api.on('shutdown', () => this.stop());
  }

  // Called by Homebridge for each accessory restored from cache, before didFinishLaunching.
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  whenStarted(): Promise<void> {
    return this.startPromise ?? Promise.resolve();
  }

  pollSeconds(): number {
    return numberOption(this.pluginConfig.pollInterval, DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS, MAX_POLL_SECONDS);
  }

  // Safety net only: re-reads home data so a missed push, a rename, or a new device is picked up eventually.
  async reconcile(): Promise<void> {
    this.mqtt?.resubscribe(); // heals a subscription the broker silently dropped
    if (this.sessionExpiredLogged) {
      await this.adoptNewSession();
    }
    await this.syncFromCloud('re-sync');
  }

  private sensorOptions(): SensorOptions {
    const c = this.pluginConfig;
    return {
      docked: c.exposeDocked ?? true,
      leaving: c.exposeLeaving ?? true,
      mowing: c.exposeMowing ?? true,
      returning: c.exposeReturning ?? true,
      attention: c.exposeAttention ?? true,
      battery: c.exposeBattery ?? true,
      faultIndicator: c.faultIndicator ?? true,
      controls: c.exposeControls ?? false,
      debounceSeconds: numberOption(c.sensorDebounceSeconds, 3, 0, 60),
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async start(): Promise<void> {
    const session = await (this.deps.readSession ?? readSession)(this.api.user.storagePath());
    if (!session) {
      this.log.warn(`${PLATFORM_NAME}: not signed in. Open the plugin settings in the Homebridge UI to sign in.`);
      return;
    }
    if (this.stopped) {
      return;
    }
    this.useSession(session);

    // MQTT first: it only needs the session, so cached mowers get live updates even if the cloud is unreachable right now.
    this.startMqtt(session);

    const synced = await this.syncFromCloud('startup');
    if (this.stopped) {
      return;
    }
    if (!synced) {
      this.log.warn(`Roborock cloud sync will be retried in ${STARTUP_RETRY_MS / 60_000} minutes.`);
      this.retryTimer = setTimeout(() => void this.reconcile(), STARTUP_RETRY_MS);
      this.retryTimer.unref?.();
    }
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.pollSeconds() * 1000);
    this.reconcileTimer.unref?.();
  }

  private useSession(session: StoredSession): void {
    this.session = session;
    this.homeId = undefined;
    this.webApi = new RoborockWebApi({
      email: session.email, clientId: session.clientId, region: session.region, fetch: this.deps.fetch, now: this.deps.now,
    });
  }

  // The UI writes a new session file when the user signs in again; use it for cloud calls without waiting for a restart.
  private async adoptNewSession(): Promise<void> {
    let session: StoredSession | undefined;
    try {
      session = await (this.deps.readSession ?? readSession)(this.api.user.storagePath());
    } catch (error) {
      this.log.debug(`Could not re-read the session file: ${message(error)}`);
      return;
    }
    if (!session || session.userData.token === this.session?.userData.token) {
      return;
    }
    this.log.info('Picked up the new Roborock sign-in. Restart Homebridge if live updates do not resume.');
    this.useSession(session);
    this.sessionExpiredLogged = false;
  }

  private stop(): void {
    this.stopped = true;
    this.mqtt?.stop();
    clearInterval(this.reconcileTimer);
    clearTimeout(this.retryTimer);
    for (const tracked of this.mowers.values()) {
      tracked.accessory.dispose();
    }
  }

  private startMqtt(session: StoredSession): void {
    try {
      this.mqtt = new RoborockMqtt(session.userData.rriot, this.log, this.deps.connectMqtt);
      this.mqtt.onConnectionChange((connected) => {
        for (const tracked of this.mowers.values()) {
          tracked.accessory.setOnline(connected && tracked.online);
        }
        if (!connected) {
          this.log.warn('Roborock MQTT disconnected; sensors marked inactive until it reconnects.');
        }
      });
      this.restoreFromCache();
      this.mqtt.start();
    } catch (error) {
      this.log.error(`Roborock MQTT could not start: ${message(error)}. State will only refresh every ${this.pollSeconds()}s.`);
      this.mqtt = undefined;
      this.restoreFromCache();
    }
  }

  // With no broker at all the sensors are fed by the cloud poll, so they count as active; with one, only once it is up.
  private get live(): boolean {
    return this.mqtt ? this.mqtt.connected : true;
  }

  // Accessories Homebridge restored carry the device identity in their context, so they can be tracked before any cloud call.
  private restoreFromCache(): void {
    for (const platformAccessory of this.accessories.values()) {
      const device = (platformAccessory.context as MowerContext).device;
      if (device?.duid && !this.mowers.has(device.duid)) {
        this.track(platformAccessory, device);
      }
    }
  }

  private track(platformAccessory: PlatformAccessory, device: CachedDevice): TrackedMower {
    const accessory = new MowerAccessory(
      this.api.hap, platformAccessory, this.log, this.sensorOptions(),
      (action) => this.command(device, action),
    );
    accessory.setInformation({ model: device.model, serial: device.sn, firmware: device.fv });
    const tracked: TrackedMower = { device, online: true, platformAccessory, accessory, dps: {} };
    this.mowers.set(device.duid, tracked);
    accessory.setOnline(this.live);
    this.subscribeMqtt(tracked);
    return tracked;
  }

  private subscribeMqtt(tracked: TrackedMower): void {
    if (!this.mqtt) {
      return;
    }
    if (!tracked.device.localKey) {
      this.log.error(`${tracked.device.name}: no localKey in home data; live updates unavailable.`);
      return;
    }
    this.mqtt.subscribe(tracked.device.duid, tracked.device.localKey, (dps) => this.applyDps(tracked, dps, 'push'));
  }

  // Runs from timers, so it must never reject: an unhandled rejection would take Homebridge down.
  private async syncFromCloud(reason: string): Promise<boolean> {
    if (!this.webApi || !this.session) {
      return false;
    }
    try {
      this.homeId ??= await this.webApi.getHomeId(this.session.userData);
      const home = await this.webApi.getHomeData(this.session.userData, this.homeId);
      if (this.stopped) {
        return true;
      }
      this.sessionExpiredLogged = false;
      this.syncMowers(home);
      await this.saveStatus();
      return true;
    } catch (error) {
      if (isSessionExpired(error)) {
        if (!this.sessionExpiredLogged) {
          this.sessionExpiredLogged = true;
          this.log.error('Roborock session is no longer valid. Sign in again in the plugin settings.');
        }
        await this.saveStatus(SESSION_EXPIRED);
      } else {
        this.log.warn(`Roborock cloud ${reason} failed: ${message(error)}`);
      }
      return false;
    }
  }

  // Creates/updates one accessory per mower on the account. A successful sync is the source of truth:
  // failures never reach here, so a mower that is not listed has left the account and is removed.
  private syncMowers(home: HomeData): void {
    const devices = findMowers(home);
    if (devices.length === 0) {
      const listed = (home.devices?.length ?? 0) + (home.receivedDevices?.length ?? 0);
      this.log.warn(`No mower found on this Roborock account (${listed} other device(s)).`);
    }

    const seen = new Set<string>();
    let staleSubscription = false;
    for (const device of devices) {
      seen.add(device.duid);
      const cached = toCached(device);
      let tracked = this.mowers.get(device.duid);
      if (!tracked) {
        const uuid = this.api.hap.uuid.generate(device.duid);
        let platformAccessory = this.accessories.get(uuid);
        if (!platformAccessory) {
          platformAccessory = new this.api.platformAccessory(device.name, uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
          this.accessories.set(uuid, platformAccessory);
        }
        tracked = this.track(platformAccessory, cached);
        this.log.info(`Found mower "${device.name}" (model=${device.model}, pv=${device.pv}, online=${device.online})`);
      } else if (cached.localKey !== tracked.device.localKey) {
        // Re-pairing the mower in the app rotates its key; pushes on the old key would decrypt to nothing, silently.
        tracked.device = cached;
        this.subscribeMqtt(tracked);
      }
      tracked.device = cached;
      (tracked.platformAccessory.context as MowerContext).device = cached;

      if (tracked.platformAccessory.displayName !== device.name) {
        this.log.info(`Renaming "${tracked.platformAccessory.displayName}" to "${device.name}" (changed in the Roborock app)`);
        tracked.platformAccessory.displayName = device.name;
        tracked.accessory.rename(device.name);
      }
      this.api.updatePlatformAccessories([tracked.platformAccessory]);

      // A push fresher than STALE_PUSH_MS always beats the snapshot, whatever the connection looks like.
      // An older push has aged out: merge the snapshot (battery, charge, errors heal too). Only when both sides
      // carry a definite state AND they contradict each other on a live connection is the subscription presumed
      // dead — that is what a silent broker drop looks like from here.
      const pushAge = tracked.lastPushAt === undefined ? Infinity : this.now() - tracked.lastPushAt;
      if (pushAge > STALE_PUSH_MS) {
        const snapshotMowState = deriveMowerState(toNumericDps(device.deviceStatus ?? {})).mowState;
        const pushMowState = tracked.last?.mowState;
        if (snapshotMowState !== undefined && pushMowState !== undefined && snapshotMowState !== pushMowState
          && (this.mqtt?.connected ?? false)) {
          this.log.warn(`${device.name}: no live update for ${Math.round(pushAge / 60_000)} min and the cloud disagrees; `
            + 'applying the cloud snapshot and reconnecting MQTT.');
          staleSubscription = true;
        }
        this.applyDps(tracked, device.deviceStatus ?? {}, 'cloud');
      } else {
        this.log.debug(`${device.name}: cloud snapshot ignored in favour of fresh live state: ${JSON.stringify(device.deviceStatus)}`);
      }
      tracked.online = device.online !== false;
      tracked.accessory.setOnline(tracked.online && this.live);
    }

    for (const tracked of [...this.mowers.values()]) {
      if (!seen.has(tracked.device.duid)) {
        this.remove(tracked);
      }
    }
    if (staleSubscription) {
      this.mqtt?.restart();
    }
  }

  private remove(tracked: TrackedMower): void {
    this.log.info(`Removing accessory no longer on the account: ${tracked.platformAccessory.displayName}`);
    this.mqtt?.unsubscribe(tracked.device.duid);
    tracked.accessory.dispose();
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [tracked.platformAccessory]);
    this.accessories.delete(tracked.platformAccessory.UUID);
    this.mowers.delete(tracked.device.duid);
  }

  // The switch's set handler resolves only when the mower acknowledged; sensors then follow via the push.
  private async command(device: CachedDevice, action: MowerAction): Promise<void> {
    if (!this.mqtt) {
      throw new Error('Roborock MQTT is not running.');
    }
    const reply = await this.mqtt.request(device.duid, 'remote_pb', remotePbParams(action, this.now()));
    if (!isOk(reply)) {
      throw new Error(`Unexpected reply: ${JSON.stringify(reply)}`);
    }
    this.log.info(`${device.name}: ${ACTION_LABELS[action]} command acknowledged`);
  }

  private applyDps(tracked: TrackedMower, update: Record<string | number, unknown>, source: 'push' | 'cloud'): void {
    Object.assign(tracked.dps, toNumericDps(update));
    if (source === 'push') {
      tracked.lastPushAt = this.now();
    }
    const state = deriveMowerState(tracked.dps);
    if (state.mowState !== tracked.last?.mowState) {
      this.log.info(`${tracked.device.name}: ${describeMowState(state.mowState)} (battery ${state.battery ?? '?'}%)`);
    }
    if (state.attention && !tracked.last?.attention) {
      this.log.warn(`${tracked.device.name}: needs attention — ${describeAttention(state)}`);
    } else if (!state.attention && tracked.last?.attention) {
      this.log.info(`${tracked.device.name}: no longer needs attention`);
    }
    this.log.debug(`${tracked.device.name} ${source} dps: ${JSON.stringify(update)}`);
    tracked.last = state;
    tracked.accessory.update(state);
  }

  private async saveStatus(lastError?: string): Promise<void> {
    const devices: StatusDevice[] = [...this.mowers.values()].map((tracked) => ({
      duid: tracked.device.duid,
      name: tracked.device.name,
      model: tracked.device.model,
      productName: tracked.device.productName,
      online: tracked.online,
      fv: tracked.device.fv,
      mowState: tracked.last?.mowState,
      mowStateName: tracked.last ? describeMowState(tracked.last.mowState) : undefined,
      attention: tracked.last ? describeAttention(tracked.last) : undefined,
      battery: tracked.last?.battery,
    }));
    const status: PlatformStatus = { updatedAt: this.now(), devices, ...(lastError ? { lastError } : {}) };
    try {
      await writeStatus(this.api.user.storagePath(), status);
    } catch (error) {
      this.log.debug(`Could not write status file: ${message(error)}`);
    }
  }
}
