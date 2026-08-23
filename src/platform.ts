import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { findMowers } from './roborock/mower.js';
import { readSession } from './roborock/session-store.js';
import { RoborockWebApi } from './roborock/web-api.js';
import { PLATFORM_NAME } from './settings.js';

export interface RoborockMowerConfig extends PlatformConfig {
  pollInterval?: number;
}

export class RoborockMowerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly pluginConfig: RoborockMowerConfig;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.pluginConfig = config as RoborockMowerConfig;

    this.api.on('didFinishLaunching', () => void this.discoverDevices());
  }

  // Called by Homebridge for each accessory restored from cache, before didFinishLaunching.
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    const session = await readSession(this.api.user.storagePath());
    if (!session) {
      this.log.warn(`${PLATFORM_NAME}: not signed in. Open the plugin settings in the Homebridge UI to sign in.`);
      return;
    }

    try {
      const api = new RoborockWebApi({ email: session.email, clientId: session.clientId, region: session.region });
      const homeId = await api.getHomeId(session.userData);
      const home = await api.getHomeData(session.userData, homeId);
      this.log.debug(`Roborock products: ${JSON.stringify(home.products)}`);

      const mowers = findMowers(home);
      if (mowers.length === 0) {
        const total = (home.devices?.length ?? 0) + (home.receivedDevices?.length ?? 0);
        this.log.warn(`No mower found on this Roborock account (${total} other device(s)).`);
        return;
      }
      for (const mower of mowers) {
        this.log.info(`Found mower "${mower.name}" (model=${mower.model}, pv=${mower.pv}, online=${mower.online})`);
        this.log.debug(`${mower.name} deviceStatus: ${JSON.stringify(mower.deviceStatus)}`);
      }
      this.log.info('Mower accessories are not implemented yet.');
    } catch (error) {
      this.log.error(`Roborock cloud: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
