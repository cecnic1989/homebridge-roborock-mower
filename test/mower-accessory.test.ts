import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { MowerAccessory, type SensorOptions } from '../src/mower/accessory.js';
import type { DerivedState } from '../src/mower/state.js';
import { fakeAccessory, fakeHap, FakePlatformAccessory } from './fake-hap.js';
import { silentLog } from './helpers.js';

const allOn: SensorOptions = { docked: true, leaving: true, mowing: true, returning: true, battery: true, faultIndicator: true, debounceSeconds: 3 };

function state(overrides: Partial<DerivedState> = {}): DerivedState {
  return {
    docked: true, leaving: false, mowing: false, returning: false, charging: false, paused: false, fault: false,
    battery: 100, lowBattery: false, mowState: 0, errorCode: 0, ...overrides,
  };
}

function build(options: SensorOptions = allOn) {
  const fake = fakeAccessory();
  const mower = new MowerAccessory(fakeHap as never, fake.accessory, silentLog, options);
  return { ...fake, mower };
}

describe('MowerAccessory services', () => {
  test('creates one contact sensor per enabled state plus battery, each with its own subtype and name', () => {
    const { services } = build();
    assert.deepEqual(services.map((s) => s.subtype ?? s.type).sort(), ['AccessoryInformation', 'Battery', 'docked', 'leaving', 'mowing', 'returning'].sort());
    assert.equal(services.find((s) => s.subtype === 'leaving')?.value('ConfiguredName'), 'Mower Leaving');
  });

  test('omits sensors that are switched off in config', () => {
    const { services } = build({ ...allOn, leaving: false, returning: false, battery: false });
    assert.deepEqual(services.map((s) => s.subtype ?? s.type).sort(), ['AccessoryInformation', 'docked', 'mowing'].sort());
  });
});

describe('MowerAccessory state pushes', () => {
  test('docked reads as contact detected; leaving/mowing/returning read as contact NOT detected when active', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { mower, find } = build();
    mower.update(state({ docked: false, leaving: true }));
    mock.timers.tick(3000);
    assert.equal(find(fakeHap.Service.ContactSensor, 'docked')?.value('ContactSensorState'), 1);
    assert.equal(find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 1);
    assert.equal(find(fakeHap.Service.ContactSensor, 'mowing')?.value('ContactSensorState'), 0);
    mock.timers.reset();
  });

  test('pushes a characteristic only when its value changes', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { mower, updates } = build();
    mower.update(state());
    mock.timers.tick(3000);
    const after = updates.length;
    mower.update(state());
    mower.update(state());
    mock.timers.tick(3000);
    assert.equal(updates.length, after);
    mock.timers.reset();
  });

  test('a blip shorter than the debounce never reaches HomeKit', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { mower, updates } = build();
    mower.update(state());
    mock.timers.tick(3000);
    const before = updates.filter((u) => u.service === 'docked').length;
    mower.update(state({ docked: false }));
    mock.timers.tick(1000);
    mower.update(state({ docked: true }));
    mock.timers.tick(5000);
    assert.equal(updates.filter((u) => u.service === 'docked').length, before);
    mock.timers.reset();
  });

  test('fault and battery bypass the debounce', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { mower, find } = build();
    mower.update(state({ fault: true, battery: 15, lowBattery: true, charging: true }));
    assert.equal(find(fakeHap.Service.ContactSensor, 'docked')?.value('StatusFault'), 1);
    assert.equal(find(fakeHap.Service.Battery)?.value('BatteryLevel'), 15);
    assert.equal(find(fakeHap.Service.Battery)?.value('StatusLowBattery'), 1);
    assert.equal(find(fakeHap.Service.Battery)?.value('ChargingState'), 1);
    mock.timers.reset();
  });

  test('going offline flips StatusActive on every sensor', () => {
    const { mower, services } = build();
    mower.setOnline(false);
    const sensors = services.filter((s) => s.type === 'ContactSensor');
    assert.equal(sensors.length, 4);
    assert.ok(sensors.every((s) => s.value('StatusActive') === false));
  });
});

describe('MowerAccessory naming', () => {
  test('keeps a ConfiguredName the user set in the Home app when restoring from cache', () => {
    const cached = new FakePlatformAccessory('Mower', 'uuid-1');
    cached.addService(fakeHap.Service.ContactSensor, 'Mower Docked', 'docked').setCharacteristic(fakeHap.Characteristic.ConfiguredName, 'Garage Mower Home');
    new MowerAccessory(fakeHap as never, cached as never, silentLog, allOn);
    assert.equal(cached.find(fakeHap.Service.ContactSensor, 'docked')?.value('ConfiguredName'), 'Garage Mower Home');
  });

  test('rename follows the Roborock app name on every service Name', () => {
    const { mower, services } = build();
    mower.rename('Front Lawn');
    assert.ok(services.filter((s) => s.type === 'ContactSensor').every((s) => String(s.value('Name')).startsWith('Front Lawn ')));
  });

  test('dispose cancels a pending debounced flip', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { mower, updates } = build();
    mower.update(state());
    const before = updates.length;
    mower.update(state({ docked: false }));
    mower.dispose();
    mock.timers.tick(10_000);
    assert.equal(updates.length, before);
    mock.timers.reset();
  });
});
