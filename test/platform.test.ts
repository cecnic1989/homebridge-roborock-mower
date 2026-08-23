import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { PlatformAccessory } from 'homebridge';

import registerPlugin from '../src/index.js';
import { RoborockMowerPlatform } from '../src/platform.js';
import type { HomeData, StoredSession } from '../src/roborock/types.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { fakeFetch } from './fake-fetch.js';
import { fakeHap } from './fake-hap.js';
import { buildV1Frame } from './frame-builder.js';
import { fakeApi, silentLog } from './helpers.js';

const home = JSON.parse(readFileSync(new URL('./fixtures/home-data.json', import.meta.url), 'utf8')) as HomeData;
const session: StoredSession = {
  email: 'user@example.com',
  clientId: 'client-1',
  region: { baseUrl: 'https://usiot.roborock.com', country: 'US', countryCode: '1' },
  userData: { token: 'tok', rriot: { u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { a: 'https://api-us.roborock.com', m: 'ssl://mqtt-us.roborock.com:8883' } } },
};

class FakeMqttClient extends EventEmitter {
  connected = false;
  subscriptions: string[] = [];
  subscribe(topic: string, _opts: unknown, cb?: (err?: Error) => void) {
    this.subscriptions.push(topic);
    cb?.();
    return this;
  }
  end() {
    return this;
  }
}

function cloud() {
  return fakeFetch({
    '/api/v1/getHomeDetail': { code: 200, data: { rrHomeId: 42 } },
    '/v3/user/homes/42': { success: true, result: home },
  });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function start(options: { session?: StoredSession; connectMqtt?: () => FakeMqttClient; config?: Record<string, unknown> } = {}) {
  const { api, accessories, emit } = fakeApi();
  const { fetch, calls } = cloud();
  const client = new FakeMqttClient();
  const platform = new RoborockMowerPlatform(silentLog, { platform: PLATFORM_NAME, sensorDebounceSeconds: 0, ...options.config }, api, {
    fetch,
    readSession: async () => options.session,
    connectMqtt: (options.connectMqtt ?? (() => client)) as never,
  });
  emit('didFinishLaunching');
  return { platform, accessories, calls, client };
}

describe('plugin registration', () => {
  test('registers the platform under PLATFORM_NAME', () => {
    const { api, registered } = fakeApi();
    registerPlugin(api);
    assert.deepEqual(registered, [{ name: PLATFORM_NAME, ctor: RoborockMowerPlatform }]);
  });
});

describe('RoborockMowerPlatform startup', () => {
  test('caches restored accessories by UUID', () => {
    const { api } = fakeApi();
    const platform = new RoborockMowerPlatform(silentLog, { platform: PLATFORM_NAME }, api);
    const accessory = { UUID: 'abc', displayName: 'Mower' } as PlatformAccessory;
    platform.configureAccessory(accessory);
    assert.equal(platform.accessories.get('abc'), accessory);
  });

  test('without a session it touches neither the cloud nor HomeKit', async () => {
    const { calls, accessories } = start();
    await settle();
    assert.equal(calls.length, 0);
    assert.equal(accessories.length, 0);
  });

  test('makes exactly one home-data call, registers the mower, seeds its state and subscribes to its MQTT topic', async () => {
    const { calls, accessories, client } = start({ session });
    await settle();
    client.connected = true;
    client.emit('connect');
    assert.deepEqual(calls.map((c) => c.url.pathname), ['/api/v1/getHomeDetail', '/v3/user/homes/42']);
    assert.equal(accessories.length, 1);
    const docked = accessories[0].find(fakeHap.Service.ContactSensor, 'docked');
    assert.equal(docked?.value('ContactSensorState'), 0, 'seeded from deviceStatus: on dock, charge complete');
    assert.equal(accessories[0].find(fakeHap.Service.Battery)?.value('BatteryLevel'), 100);
    assert.deepEqual(client.subscriptions, ['rr/m/o/u1/b7b04791/mower-duid']);
  });

  test('still registers the mower from the single home-data call when MQTT cannot start', async () => {
    const connectMqtt = () => {
      throw new Error('boom');
    };
    const { calls, accessories } = start({ session, connectMqtt });
    await settle();
    assert.equal(calls.filter((c) => c.url.pathname === '/v3/user/homes/42').length, 1);
    assert.equal(accessories.length, 1);
  });
});

describe('RoborockMowerPlatform live updates', () => {
  test('a DPS push flips the sensors: 51 opens Leaving and clears Docked', async () => {
    const { accessories, client } = start({ session });
    await settle();
    client.emit('message', 'rr/m/o/u1/b7b04791/mower-duid', buildV1Frame(102, 1787457040, '{"t":1787457040,"dps":{"123":51,"127":0}}', 'localkey'));
    const mower = accessories[0];
    assert.equal(mower.find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 1);
    assert.equal(mower.find(fakeHap.Service.ContactSensor, 'docked')?.value('ContactSensorState'), 1);
  });

  test('losing the broker marks sensors inactive; reconnecting restores them without a cloud call', async () => {
    const { accessories, calls, client } = start({ session });
    await settle();
    client.emit('close');
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('StatusActive'), false);
    client.emit('connect');
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('StatusActive'), true);
    assert.equal(calls.length, 2);
  });
});
