import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PlatformAccessory } from 'homebridge';

import registerPlugin from '../src/index.js';
import { RoborockMowerPlatform } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { fakeApi, silentLog } from './helpers.js';

describe('plugin registration', () => {
  test('registers the platform under PLATFORM_NAME', () => {
    const { api, registered } = fakeApi();
    registerPlugin(api);
    assert.deepEqual(registered, [{ name: PLATFORM_NAME, ctor: RoborockMowerPlatform }]);
  });
});

describe('RoborockMowerPlatform', () => {
  test('constructs and reads config', () => {
    const { api } = fakeApi();
    const platform = new RoborockMowerPlatform(silentLog, { platform: PLATFORM_NAME, pollInterval: 30 }, api);
    assert.equal(platform.pluginConfig.pollInterval, 30);
  });

  test('caches restored accessories by UUID', () => {
    const { api } = fakeApi();
    const platform = new RoborockMowerPlatform(silentLog, { platform: PLATFORM_NAME }, api);
    const accessory = { UUID: 'abc', displayName: 'Mower' } as PlatformAccessory;
    platform.configureAccessory(accessory);
    assert.equal(platform.accessories.get('abc'), accessory);
  });

  test('survives didFinishLaunching with no devices', () => {
    const { api, emit } = fakeApi();
    new RoborockMowerPlatform(silentLog, { platform: PLATFORM_NAME }, api);
    assert.doesNotThrow(() => emit('didFinishLaunching'));
  });
});
