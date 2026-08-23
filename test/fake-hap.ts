import type { PlatformAccessory } from 'homebridge';

// Just enough of HAP for the accessory tests: services keyed by (type, subtype), characteristics by name,
// and a record of every updateCharacteristic call so tests can assert "only on change".
export interface UpdateCall {
  service: string;
  characteristic: string;
  value: unknown;
}

class FakeCharacteristic {
  value: unknown;
  constructor(readonly name: string) {}
}

export class FakeService {
  readonly characteristics = new Map<string, FakeCharacteristic>();
  constructor(readonly type: string, readonly displayName: string, readonly subtype: string | undefined, private readonly updates: UpdateCall[]) {}

  getCharacteristic(c: { name: string }): FakeCharacteristic {
    let existing = this.characteristics.get(c.name);
    if (!existing) {
      existing = new FakeCharacteristic(c.name);
      this.characteristics.set(c.name, existing);
    }
    return existing;
  }

  setCharacteristic(c: { name: string }, value: unknown): this {
    this.getCharacteristic(c).value = value;
    return this;
  }

  updateCharacteristic(c: { name: string }, value: unknown): this {
    this.getCharacteristic(c).value = value;
    this.updates.push({ service: this.subtype ?? this.type, characteristic: c.name, value });
    return this;
  }

  value(name: string): unknown {
    return this.characteristics.get(name)?.value;
  }
}

function serviceType(name: string) {
  return { UUID: name, name } as unknown as { UUID: string };
}

function characteristic(name: string, constants: Record<string, number> = {}) {
  return { name, ...constants };
}

export const fakeHap = {
  Service: {
    AccessoryInformation: serviceType('AccessoryInformation'),
    ContactSensor: serviceType('ContactSensor'),
    Battery: serviceType('Battery'),
  },
  Characteristic: {
    Manufacturer: characteristic('Manufacturer'),
    Model: characteristic('Model'),
    SerialNumber: characteristic('SerialNumber'),
    FirmwareRevision: characteristic('FirmwareRevision'),
    Name: characteristic('Name'),
    ConfiguredName: characteristic('ConfiguredName'),
    ContactSensorState: characteristic('ContactSensorState', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }),
    StatusActive: characteristic('StatusActive'),
    StatusFault: characteristic('StatusFault', { NO_FAULT: 0, GENERAL_FAULT: 1 }),
    BatteryLevel: characteristic('BatteryLevel'),
    ChargingState: characteristic('ChargingState', { NOT_CHARGING: 0, CHARGING: 1, NOT_CHARGEABLE: 2 }),
    StatusLowBattery: characteristic('StatusLowBattery', { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 }),
  },
};

export class FakePlatformAccessory {
  readonly updates: UpdateCall[] = [];
  readonly services: FakeService[] = [];
  context: Record<string, unknown> = {};

  constructor(readonly displayName: string, readonly UUID: string) {}

  find(type: { UUID: string }, subtype?: string): FakeService | undefined {
    return this.services.find((s) => s.type === type.UUID && s.subtype === subtype);
  }

  getService(type: { UUID: string }): FakeService | undefined {
    return this.find(type);
  }

  getServiceById(type: { UUID: string }, subtype: string): FakeService | undefined {
    return this.find(type, subtype);
  }

  addService(type: { UUID: string }, name: string, subtype?: string): FakeService {
    const service = new FakeService(type.UUID, name, subtype, this.updates);
    this.services.push(service);
    return service;
  }

  removeService(service: FakeService): void {
    this.services.splice(this.services.indexOf(service), 1);
  }
}

export function fakeAccessory(displayName = 'Mower') {
  const accessory = new FakePlatformAccessory(displayName, 'uuid-1');
  return {
    accessory: accessory as unknown as PlatformAccessory,
    services: accessory.services,
    updates: accessory.updates,
    find: (type: { UUID: string }, subtype?: string) => accessory.find(type, subtype),
  };
}
