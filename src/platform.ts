import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import type mqtt from 'mqtt';

import { MowerAccessory, type SensorOptions } from './mower/accessory.js';
import { type Dps, deriveMowerState, describeMowState, DPS } from './mower/state.js';
import { findMowers, type MowerDevice } from './roborock/mower.js';
import { RoborockMqtt } from './roborock/mqtt-client.js';
import { readSession } from './roborock/session-store.js';
import type { HomeData, StoredSession } from './roborock/types.js';
import { RoborockWebApi } from './roborock/web-api.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export interface RoborockMowerConfig extends PlatformConfig {
  pollInterval?: number;
  exposeDocked?: boolean;
  exposeLeaving?: boolean;
  exposeMowing?: boolean;
  exposeReturning?: boolean;
  exposeBattery?: boolean;
  faultIndicator?: boolean;
  sensorDebounceSeconds?: number;
}

// Seams for tests; Homebridge itself never passes these.
export interface PlatformDeps {
  fetch?: typeof globalThis.fetch;
  readSession?: (storagePath: string) => Promise<StoredSession | undefined>;
  connectMqtt?: typeof mqtt.connect;
  now?: () => number;
}

const MIN_POLL_SECONDS = 900; // Roborock rate-limits home data; python-roborock budgets 5/hour.
const DEFAULT_POLL_SECONDS = 3600;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TrackedMower {
  device: MowerDevice;
  accessory: MowerAccessory;
  dps: Dps;
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

    this.api.on('didFinishLaunching', () => void this.start());
    this.api.on('shutdown', () => this.stop());
  }

  // Called by Homebridge for each accessory restored from cache, before didFinishLaunching.
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  private sensorOptions(): SensorOptions {
    const c = this.pluginConfig;
    return {
      docked: c.exposeDocked ?? true,
      leaving: c.exposeLeaving ?? true,
      mowing: c.exposeMowing ?? true,
      returning: c.exposeReturning ?? true,
      battery: c.exposeBattery ?? true,
      faultIndicator: c.faultIndicator ?? true,
      debounceSeconds: c.sensorDebounceSeconds ?? 3,
    };
  }

  private async start(): Promise<void> {
    const session = await (this.deps.readSession ?? readSession)(this.api.user.storagePath());
    if (!session) {
      this.log.warn(`${PLATFORM_NAME}: not signed in. Open the plugin settings in the Homebridge UI to sign in.`);
      return;
    }
    this.session = session;
    this.webApi = new RoborockWebApi({
      email: session.email, clientId: session.clientId, region: session.region, fetch: this.deps.fetch, now: this.deps.now,
    });

    let home: HomeData;
    try {
      this.homeId = await this.webApi.getHomeId(session.userData);
      home = await this.webApi.getHomeData(session.userData, this.homeId);
    } catch (error) {
      this.log.error(`Roborock cloud: ${message(error)}`);
      this.scheduleReconcile();
      return;
    }

    this.syncMowers(home);
    this.startMqtt(session);
    this.scheduleReconcile();
  }

  private stop(): void {
    this.mqtt?.stop();
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
    }
  }

  // Creates/updates one accessory per mower on the account and drops cached ones that are gone.
  private syncMowers(home: HomeData): void {
    const devices = findMowers(home);
    if (devices.length === 0) {
      const total = (home.devices?.length ?? 0) + (home.receivedDevices?.length ?? 0);
      this.log.warn(`No mower found on this Roborock account (${total} other device(s)).`);
    }

    const seen = new Set<string>();
    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.duid);
      seen.add(uuid);
      let tracked = this.mowers.get(device.duid);
      if (!tracked) {
        let platformAccessory = this.accessories.get(uuid);
        if (!platformAccessory) {
          platformAccessory = new this.api.platformAccessory(device.name, uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
          this.accessories.set(uuid, platformAccessory);
        }
        const accessory = new MowerAccessory(this.api.hap, platformAccessory, this.log, this.sensorOptions());
        accessory.setInformation({ model: device.model, serial: device.sn, firmware: device.fv });
        tracked = { device, accessory, dps: {} };
        this.mowers.set(device.duid, tracked);
        this.log.info(`Found mower "${device.name}" (model=${device.model}, pv=${device.pv}, online=${device.online})`);
      }
      tracked.device = device;
      this.applyDps(tracked, device.deviceStatus ?? {});
      tracked.accessory.setOnline(device.online !== false && (this.mqtt?.connected ?? true));
    }

    for (const [uuid, platformAccessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info(`Removing accessory no longer on the account: ${platformAccessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  private applyDps(tracked: TrackedMower, update: Record<string | number, unknown>): void {
    const previous = tracked.dps[DPS.MOW_STATE];
    for (const [key, value] of Object.entries(update)) {
      tracked.dps[Number(key)] = value;
    }
    const state = deriveMowerState(tracked.dps);
    if (state.mowState !== previous) {
      this.log.info(`${tracked.device.name}: ${describeMowState(state.mowState)} (battery ${state.battery ?? '?'}%)`);
    }
    this.log.debug(`${tracked.device.name} dps: ${JSON.stringify(update)}`);
    tracked.accessory.update(state);
  }

  private startMqtt(session: StoredSession): void {
    try {
      this.mqtt = new RoborockMqtt(session.userData.rriot, this.log, this.deps.connectMqtt);
      this.mqtt.onConnectionChange((connected) => {
        for (const tracked of this.mowers.values()) {
          tracked.accessory.setOnline(connected && tracked.device.online !== false);
        }
        if (!connected) {
          this.log.warn('Roborock MQTT disconnected; sensors marked inactive until it reconnects.');
        }
      });
      for (const tracked of this.mowers.values()) {
        if (!tracked.device.localKey) {
          this.log.error(`${tracked.device.name}: no localKey in home data; live updates unavailable.`);
          continue;
        }
        this.mqtt.subscribe(tracked.device.duid, tracked.device.localKey, (dps) => this.applyDps(tracked, dps));
      }
      this.mqtt.start();
    } catch (error) {
      this.log.error(`Roborock MQTT could not start: ${message(error)}. State will only refresh every ${this.pollSeconds()}s.`);
    }
  }

  private pollSeconds(): number {
    return Math.max(MIN_POLL_SECONDS, this.pluginConfig.pollInterval ?? DEFAULT_POLL_SECONDS);
  }

  // Safety net only: re-reads home data so a missed push or a new device is picked up eventually.
  private scheduleReconcile(): void {
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.pollSeconds() * 1000);
    this.reconcileTimer.unref?.();
  }

  private async reconcile(): Promise<void> {
    if (!this.webApi || !this.session) {
      return;
    }
    try {
      this.homeId ??= await this.webApi.getHomeId(this.session.userData);
      this.syncMowers(await this.webApi.getHomeData(this.session.userData, this.homeId));
    } catch (error) {
      this.log.warn(`Roborock cloud re-sync skipped: ${message(error)}`);
    }
  }
}
