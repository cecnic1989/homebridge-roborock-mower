import type { API, Logging, PlatformAccessory, Service } from 'homebridge';

import type { MowerAction } from './commands.js';
import type { DerivedState } from './state.js';

export interface SensorOptions {
  docked: boolean;
  leaving: boolean;
  mowing: boolean;
  returning: boolean;
  attention: boolean;
  battery: boolean;
  faultIndicator: boolean;
  controls: boolean;
  debounceSeconds: number;
}

export interface DeviceInformation {
  model: string;
  serial?: string;
  firmware?: string;
}

type SensorKey = 'docked' | 'leaving' | 'mowing' | 'returning' | 'attention';
type SwitchKey = 'mow' | 'pause';
type Hap = Pick<API['hap'], 'Service' | 'Characteristic' | 'HapStatusError' | 'HAPStatus'>;

// on/off map to opposite commands, and the displayed value always derives from the mower's own state.
const SWITCH_DEFS: { key: SwitchKey; label: string; whenOn: MowerAction; whenOff: MowerAction; active: (s: DerivedState) => boolean }[] = [
  { key: 'mow', label: 'Mow', whenOn: 'mow', whenOff: 'dock', active: (s) => s.leaving || s.mowing },
  { key: 'pause', label: 'Pause', whenOn: 'pause', whenOff: 'resume', active: (s) => s.paused },
];

const SENSOR_LABELS: Record<SensorKey, string> = {
  docked: 'Docked', leaving: 'Leaving', mowing: 'Mowing', returning: 'Returning', attention: 'Needs Attention',
};
const SENSOR_KEYS = Object.keys(SENSOR_LABELS) as SensorKey[];

// Home-app automations trigger on "opens"/"closes". Docked closes when the mower is home;
// the activity sensors open when their activity starts, so "Docked opens → open the garage" reads naturally.
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
  private readonly switches = new Map<SwitchKey, Service>();
  private readonly switchApplied = new Map<SwitchKey, boolean>();
  private readonly battery?: Service;
  private readonly applied = new Map<SensorKey, boolean>();
  private readonly pending = new Map<SensorKey, { value: boolean; timer: NodeJS.Timeout }>();
  private last: Partial<Pick<DerivedState, 'fault' | 'battery' | 'lowBattery' | 'charging'>> = {};
  private baseName: string;
  private readonly debounceMs: number;

  constructor(
    private readonly hap: Hap,
    readonly accessory: PlatformAccessory,
    private readonly log: Logging,
    private readonly options: SensorOptions,
    private readonly onCommand?: (action: MowerAction) => Promise<void>,
  ) {
    const { Service, Characteristic } = hap;
    this.baseName = accessory.displayName;
    this.debounceMs = Number.isFinite(options.debounceSeconds) && options.debounceSeconds > 0 ? options.debounceSeconds * 1000 : 0;
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
      if (existing) {
        // Restored from cache: leave Name/ConfiguredName alone so renames made in the Home app survive restarts.
        this.sensors.set(key, existing);
        continue;
      }
      const name = this.sensorName(key);
      const service = accessory.addService(Service.ContactSensor, name, key);
      service.addOptionalCharacteristic(Characteristic.ConfiguredName); // HAP does not list it for ContactSensor; avoids a Homebridge warning
      service.setCharacteristic(Characteristic.Name, name);
      service.setCharacteristic(Characteristic.ConfiguredName, name);
      this.sensors.set(key, service);
    }

    const existingBattery = accessory.getService(Service.Battery);
    if (options.battery) {
      this.battery = existingBattery ?? accessory.addService(Service.Battery, `${this.baseName} Battery`);
    } else if (existingBattery) {
      accessory.removeService(existingBattery);
    }

    for (const definition of SWITCH_DEFS) {
      const existing = accessory.getServiceById(Service.Switch, definition.key);
      if (!options.controls || !this.onCommand) {
        if (existing) {
          accessory.removeService(existing);
        }
        continue;
      }
      let service = existing;
      if (!service) {
        const name = `${this.baseName} ${definition.label}`;
        service = accessory.addService(Service.Switch, name, definition.key);
        service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        service.setCharacteristic(Characteristic.Name, name);
        service.setCharacteristic(Characteristic.ConfiguredName, name);
      }
      service.getCharacteristic(Characteristic.On)
        .onSet((value) => this.handleSwitchSet(definition, Boolean(value)));
      this.switches.set(definition.key, service);
    }
  }

  // HomeKit applies the written value only when this resolves; a failure keeps the old value and shows an error.
  private async handleSwitchSet(definition: (typeof SWITCH_DEFS)[number], value: boolean): Promise<void> {
    try {
      await this.onCommand!(value ? definition.whenOn : definition.whenOff);
      this.switchApplied.set(definition.key, value);
    } catch (error) {
      this.log.warn(`${this.baseName}: ${definition.label} ${value ? 'on' : 'off'} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
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

  // Follows a rename made in the Roborock app. ConfiguredName is only touched if the user never changed it in Home.
  rename(displayName: string): void {
    const c = this.hap.Characteristic;
    const previousBase = this.baseName;
    this.baseName = displayName;
    for (const [key, service] of this.sensors) {
      const previous = `${previousBase} ${SENSOR_LABELS[key]}`;
      const next = this.sensorName(key);
      service.updateCharacteristic(c.Name, next);
      if (service.getCharacteristic(c.ConfiguredName).value === previous) {
        service.updateCharacteristic(c.ConfiguredName, next);
      }
    }
    for (const definition of SWITCH_DEFS) {
      const service = this.switches.get(definition.key);
      if (service) {
        service.updateCharacteristic(c.Name, `${displayName} ${definition.label}`);
        if (service.getCharacteristic(c.ConfiguredName).value === `${previousBase} ${definition.label}`) {
          service.updateCharacteristic(c.ConfiguredName, `${displayName} ${definition.label}`);
        }
      }
    }
    this.battery?.updateCharacteristic(c.Name, `${displayName} Battery`);
  }

  update(state: DerivedState): void {
    for (const key of this.sensors.keys()) {
      if (key === 'attention') {
        this.applyIfChanged(key, state.attention); // never debounced: a fault must reach the phone on the push that reports it
      } else {
        this.schedule(key, state[key]);
      }
    }
    for (const definition of SWITCH_DEFS) {
      const service = this.switches.get(definition.key);
      const value = definition.active(state);
      if (service && this.switchApplied.get(definition.key) !== value) {
        this.switchApplied.set(definition.key, value);
        service.updateCharacteristic(this.hap.Characteristic.On, value);
      }
    }
    this.pushFault(state.fault);
    this.pushBattery(state);
  }

  setOnline(online: boolean): void {
    for (const service of this.sensors.values()) {
      service.updateCharacteristic(this.hap.Characteristic.StatusActive, online);
    }
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
  }

  private sensorName(key: SensorKey): string {
    return `${this.baseName} ${SENSOR_LABELS[key]}`;
  }

  // Activity flags must hold for the debounce period before HomeKit sees them; the first value is applied immediately.
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
    if (!this.applied.has(key) || this.debounceMs === 0) {
      this.apply(key, value);
      return;
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.apply(key, value);
    }, this.debounceMs);
    this.pending.set(key, { value, timer });
  }

  private applyIfChanged(key: SensorKey, value: boolean): void {
    if (this.applied.get(key) !== value) {
      this.apply(key, value);
    }
  }

  private apply(key: SensorKey, value: boolean): void {
    this.applied.set(key, value);
    this.sensors.get(key)?.updateCharacteristic(this.hap.Characteristic.ContactSensorState, contactValue(key, value, this.hap.Characteristic));
    this.log.debug(`${this.baseName}: ${SENSOR_LABELS[key]} ${value ? 'on' : 'off'}`);
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
