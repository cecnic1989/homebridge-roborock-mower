import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

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

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  // Called by Homebridge for each accessory restored from cache, before didFinishLaunching.
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  private discoverDevices(): void {
    this.log.info(`${PLATFORM_NAME}: device discovery not implemented yet`);
  }
}
