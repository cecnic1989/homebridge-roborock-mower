import type { API, Logging, PlatformAccessory, Service } from 'homebridge';

import type { DerivedState } from './state.js';

export interface SensorOptions {
  docked: boolean;
  leaving: boolean;
  mowing: boolean;
  returning: boolean;
  battery: boolean;
  faultIndicator: boolean;
  debounceSeconds: number;
}

export interface DeviceInformation {
  model: string;
  serial?: string;
  firmware?: string;
}

type SensorKey = 'docked' | 'leaving' | 'mowing' | 'returning';
type Hap = Pick<API['hap'], 'Service' | 'Characteristic'>;

const SENSOR_LABELS: Record<SensorKey, string> = { docked: 'Docked', leaving: 'Leaving', mowing: 'Mowing', returning: 'Returning' };
const SENSOR_KEYS = Object.keys(SENSOR_LABELS) as SensorKey[];

// Home-app automations trigger on "opens"/"closes". Docked closes when the mower is home;
// the activity sensors open when their activity starts, so "Leaving opens → open the garage" reads naturally.
function contactValue(key: SensorKey, active: boolean, c: Hap['Characteristic']): number {
  const detected = c.ContactSensorState.CONTACT_DETECTED;
  const notDetected = c.ContactSensorState.CONTACT_NOT_DETECTED;
  if (key === 'docked') {
    return active ? detected : notDetected;
  }
  return active ? notDetected : detected;
}

export class MowerAccessory {
  private readonly sensors = new Map<SensorKey, Service>();
  private readonly battery?: Service;
  private readonly applied = new Map<SensorKey, boolean>();
  private readonly pending = new Map<SensorKey, { value: boolean; timer: NodeJS.Timeout }>();
  private last: Partial<Pick<DerivedState, 'fault' | 'battery' | 'lowBattery' | 'charging'>> = {};

  constructor(
    private readonly hap: Hap,
    readonly accessory: PlatformAccessory,
    private readonly log: Logging,
    private readonly options: SensorOptions,
  ) {
    const { Service, Characteristic } = hap;
    if (!accessory.getService(Service.AccessoryInformation)) {
      accessory.addService(Service.AccessoryInformation);
    }

    for (const key of SENSOR_KEYS) {
      const existing = accessory.getServiceById(Service.ContactSensor, key);
      if (!options[key]) {
        if (existing) {
          accessory.removeService(existing);
        }
        continue;
      }
      const name = `${accessory.displayName} ${SENSOR_LABELS[key]}`;
      const service = existing ?? accessory.addService(Service.ContactSensor, name, key);
      service.setCharacteristic(Characteristic.Name, name);
      service.setCharacteristic(Characteristic.ConfiguredName, name);
      this.sensors.set(key, service);
    }

    const existingBattery = accessory.getService(Service.Battery);
    if (options.battery) {
      this.battery = existingBattery ?? accessory.addService(Service.Battery, `${accessory.displayName} Battery`);
    } else if (existingBattery) {
      accessory.removeService(existingBattery);
    }
  }

  setInformation(info: DeviceInformation): void {
    const { Service, Characteristic } = this.hap;
    this.accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Roborock')
      .setCharacteristic(Characteristic.Model, info.model)
      .setCharacteristic(Characteristic.SerialNumber, info.serial ?? this.accessory.UUID)
      .setCharacteristic(Characteristic.FirmwareRevision, info.firmware ?? '0');
  }

  update(state: DerivedState): void {
    for (const key of this.sensors.keys()) {
      this.schedule(key, state[key]);
    }
    this.pushFault(state.fault);
    this.pushBattery(state);
  }

  setOnline(online: boolean): void {
    for (const service of this.sensors.values()) {
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, online);
    }
  }

  // Activity flags must hold for debounceSeconds before HomeKit sees them; the first value is applied immediately.
  private schedule(key: SensorKey, value: boolean): void {
    const pending = this.pending.get(key);
    if (this.applied.get(key) === value) {
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
      }
      return;
    }
    if (pending?.value === value) {
      return;
    }
    if (pending) {
      clearTimeout(pending.timer);
    }
    if (!this.applied.has(key) || this.options.debounceSeconds <= 0) {
      this.apply(key, value);
      return;
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.apply(key, value);
    }, this.options.debounceSeconds * 1000);
    this.pending.set(key, { value, timer });
  }

  private apply(key: SensorKey, value: boolean): void {
    this.applied.set(key, value);
    this.sensors.get(key)?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, contactValue(key, value, this.hap.Characteristic));
    this.log.debug(`${this.accessory.displayName}: ${SENSOR_LABELS[key]} ${value ? 'on' : 'off'}`);
  }

  private pushFault(fault: boolean): void {
    if (!this.options.faultIndicator || this.last.fault === fault) {
      return;
    }
    this.last.fault = fault;
    const c = this.hap.Characteristic;
    for (const service of this.sensors.values()) {
      service.updateCharacteristic(c.StatusFault, fault ? c.StatusFault.GENERAL_FAULT : c.StatusFault.NO_FAULT);
    }
  }

  private pushBattery(state: DerivedState): void {
    if (!this.battery) {
      return;
    }
    const c = this.hap.Characteristic;
    if (state.battery !== undefined && state.battery !== this.last.battery) {
      this.last.battery = state.battery;
      this.battery.updateCharacteristic(c.BatteryLevel, state.battery);
    }
    if (state.lowBattery !== this.last.lowBattery) {
      this.last.lowBattery = state.lowBattery;
      this.battery.updateCharacteristic(c.StatusLowBattery, state.lowBattery ? c.StatusLowBattery.BATTERY_LEVEL_LOW : c.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    }
    if (state.charging !== this.last.charging) {
      this.last.charging = state.charging;
      this.battery.updateCharacteristic(c.ChargingState, state.charging ? c.ChargingState.CHARGING : c.ChargingState.NOT_CHARGING);
    }
  }
}
