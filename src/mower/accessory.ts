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
// Mow follows the job (DPS 132), not the wheels: a paused or rain-docked job still reads "on" — turning it
// off then is a deliberate cancel, and on/off automations do not misfire mid-job.
const SWITCH_DEFS: { key: SwitchKey; label: string; whenOn: MowerAction; whenOff: MowerAction; active: (s: DerivedState) => boolean }[] = [
  { key: 'mow', label: 'Mow', whenOn: 'mow', whenOff: 'dock', active: (s) => s.jobActive || s.leaving || s.mowing },
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
  private readonly battery?: Service;
  private readonly applied = new Map<string, boolean>();
  private readonly pending = new Map<string, { value: boolean; timer: NodeJS.Timeout }>();
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
      this.sensors.set(key, this.createNamedService(Service.ContactSensor, key, SENSOR_LABELS[key]));
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
      const service = existing ?? this.createNamedService(Service.Switch, definition.key, definition.label);
      service.getCharacteristic(Characteristic.On)
        .onSet((value) => this.handleSwitchSet(definition, Boolean(value)));
      this.switches.set(definition.key, service);
    }
  }

  private createNamedService(type: typeof this.hap.Service.ContactSensor, key: string, label: string): Service {
    const name = `${this.baseName} ${label}`;
    const service = this.accessory.addService(type, name, key);
    // ConfiguredName is not in HAP's list for these services; declaring it avoids a Homebridge warning.
    service.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
    service.setCharacteristic(this.hap.Characteristic.Name, name);
    service.setCharacteristic(this.hap.Characteristic.ConfiguredName, name);
    return service;
  }

  // HomeKit applies the written value only when this resolves; a failure keeps the old value and shows an error.
  // On success, the applied map adopts the user's value so a lagging push must out-live the debounce to override it.
  private async handleSwitchSet(definition: (typeof SWITCH_DEFS)[number], value: boolean): Promise<void> {
    try {
      await this.onCommand!(value ? definition.whenOn : definition.whenOff);
      this.applied.set(definition.key, value);
      const pending = this.pending.get(definition.key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(definition.key);
      }
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
    for (const [service, label] of this.namedServices()) {
      this.renameService(service, `${previousBase} ${label}`, `${displayName} ${label}`);
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
      if (this.switches.has(definition.key)) {
        this.schedule(definition.key, definition.active(state)); // debounced like the sensors: no flicker across pushes
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

  private *namedServices(): Iterable<[Service, string]> {
    for (const [key, service] of this.sensors) {
      yield [service, SENSOR_LABELS[key]];
    }
    for (const definition of SWITCH_DEFS) {
      const service = this.switches.get(definition.key);
      if (service) {
        yield [service, definition.label];
      }
    }
  }

  // The rule in one place: Name always follows; ConfiguredName only if the user never changed it in Home.
  private renameService(service: Service, previousName: string, nextName: string): void {
    const c = this.hap.Characteristic;
    service.updateCharacteristic(c.Name, nextName);
    if (service.getCharacteristic(c.ConfiguredName).value === previousName) {
      service.updateCharacteristic(c.ConfiguredName, nextName);
    }
  }

  // Activity flags must hold for the debounce period before HomeKit sees them; the first value is applied immediately.
  private schedule(key: string, value: boolean): void {
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

  private apply(key: string, value: boolean): void {
    this.applied.set(key, value);
    const sensor = this.sensors.get(key as SensorKey);
    if (sensor) {
      sensor.updateCharacteristic(this.hap.Characteristic.ContactSensorState, contactValue(key as SensorKey, value, this.hap.Characteristic));
      this.log.debug(`${this.baseName}: ${SENSOR_LABELS[key as SensorKey]} ${value ? 'on' : 'off'}`);
      return;
    }
    this.switches.get(key as SwitchKey)?.updateCharacteristic(this.hap.Characteristic.On, value);
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
