import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { MowerAccessory, type SensorOptions } from '../src/mower/accessory.js';
import type { MowerAction } from '../src/mower/commands.js';
import type { DerivedState } from '../src/mower/state.js';
import { fakeAccessory, fakeHap, FakeHapStatusError, FakePlatformAccessory } from './fake-hap.js';
import { silentLog } from './helpers.js';

const allOn: SensorOptions = {
  docked: true, leaving: true, mowing: true, returning: true, attention: true, battery: true, faultIndicator: true,
  controls: false, debounceSeconds: 3,
};

function state(overrides: Partial<DerivedState> = {}): DerivedState {
  return {
    docked: true, leaving: false, mowing: false, returning: false, charging: false, paused: false, fault: false, attention: false,
    jobActive: false, battery: 100, lowBattery: false, mowState: 0, errorCode: 0, ...overrides,
  };
}

function build(options: SensorOptions = allOn, onCommand?: (action: MowerAction) => Promise<void>) {
  const fake = fakeAccessory();
  const mower = new MowerAccessory(fakeHap as never, fake.accessory, silentLog, options, onCommand);
  return { ...fake, mower };
}

function buildControls(onCommand: (action: MowerAction) => Promise<void>) {
  return build({ ...allOn, controls: true }, onCommand);
}

describe('MowerAccessory services', () => {
  test('creates one contact sensor per enabled state plus battery, each with its own subtype and name', () => {
    const { services } = build();
    assert.deepEqual(
      services.map((s) => s.subtype ?? s.type).sort(),
      ['AccessoryInformation', 'Battery', 'docked', 'leaving', 'mowing', 'returning', 'attention'].sort(),
    );
    assert.equal(services.find((s) => s.subtype === 'leaving')?.value('ConfiguredName'), 'Mower Leaving');
    assert.equal(services.find((s) => s.subtype === 'attention')?.value('ConfiguredName'), 'Mower Needs Attention');
  });

  test('omits sensors that are switched off in config', () => {
    const { services } = build({ ...allOn, leaving: false, returning: false, attention: false, battery: false });
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

  test('needs-attention opens immediately, without the debounce, and closes when the condition clears', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { mower, find } = build();
    mower.update(state());
    mock.timers.tick(3000);
    mower.update(state({ attention: true, fault: true }));
    assert.equal(find(fakeHap.Service.ContactSensor, 'attention')?.value('ContactSensorState'), 1, 'opens on the same push');
    mower.update(state());
    assert.equal(find(fakeHap.Service.ContactSensor, 'attention')?.value('ContactSensorState'), 0);
    mock.timers.reset();
  });

  test('going offline flips StatusActive on every sensor', () => {
    const { mower, services } = build();
    mower.setOnline(false);
    const sensors = services.filter((s) => s.type === 'ContactSensor');
    assert.equal(sensors.length, 5);
    assert.ok(sensors.every((s) => s.value('StatusActive') === false));
  });
});

describe('MowerAccessory controls', () => {
  test('switches exist only when controls are enabled and a command channel is wired', () => {
    const { services } = buildControls(async () => {});
    assert.ok(services.some((s) => s.subtype === 'mow'));
    assert.ok(services.some((s) => s.subtype === 'pause'));
    assert.equal(build().services.some((s) => s.type === 'Switch'), false);
  });

  test('turning Mow on sends mow, off sends dock; Pause maps to pause/resume', async () => {
    const actions: MowerAction[] = [];
    const { find } = buildControls(async (action) => {
      actions.push(action);
    });
    await find(fakeHap.Service.Switch, 'mow')?.triggerSet('On', true);
    await find(fakeHap.Service.Switch, 'mow')?.triggerSet('On', false);
    await find(fakeHap.Service.Switch, 'pause')?.triggerSet('On', true);
    await find(fakeHap.Service.Switch, 'pause')?.triggerSet('On', false);
    assert.deepEqual(actions, ['mow', 'dock', 'pause', 'resume']);
    assert.equal(find(fakeHap.Service.Switch, 'mow')?.value('On'), false);
  });

  test('a failed command surfaces a HapStatusError and the switch keeps its truthful value', async () => {
    const { mower, find } = buildControls(async () => {
      throw new Error('mower unreachable');
    });
    mower.update(state()); // docked: Mow reads off
    await assert.rejects(find(fakeHap.Service.Switch, 'mow')!.triggerSet('On', true), (e) => e instanceof FakeHapStatusError);
    assert.equal(find(fakeHap.Service.Switch, 'mow')?.value('On'), false);
  });

  test('switch state mirrors the mower: an app-started job turns Mow on, a pause turns Pause on', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { mower, find } = buildControls(async () => {});
    mower.update(state({ docked: false, mowing: true, jobActive: true }));
    mock.timers.tick(3000);
    assert.equal(find(fakeHap.Service.Switch, 'mow')?.value('On'), true);
    mower.update(state({ docked: false, paused: true, jobActive: true }));
    mock.timers.tick(3000);
    assert.equal(find(fakeHap.Service.Switch, 'mow')?.value('On'), true, 'a paused job is still a job — off would restart the whole lawn');
    assert.equal(find(fakeHap.Service.Switch, 'pause')?.value('On'), true);
    mock.timers.reset();
  });

  test('a push that lags the command does not yank the switch back (no on-off-on flicker)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { mower, find, updates } = buildControls(async () => {});
    mower.update(state()); // docked, no job
    mock.timers.tick(3000);
    await find(fakeHap.Service.Switch, 'mow')!.triggerSet('On', true);
    const before = updates.filter((u) => u.service === 'mow').length;
    mower.update(state()); // the mower has not reported the job yet — a stale push or cloud poll
    mock.timers.tick(1000);
    mower.update(state({ docked: false, jobActive: true })); // now it has
    mock.timers.tick(5000);
    assert.equal(find(fakeHap.Service.Switch, 'mow')?.value('On'), true);
    assert.equal(updates.filter((u) => u.service === 'mow').length, before, 'no characteristic churn during the transition');
    mock.timers.reset();
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
