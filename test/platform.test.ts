import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { PlatformAccessory } from 'homebridge';

import registerPlugin from '../src/index.js';
import { RoborockMowerPlatform } from '../src/platform.js';
import { readStatus } from '../src/roborock/session-store.js';
import type { HomeData, StoredSession } from '../src/roborock/types.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { fakeFetch } from './fake-fetch.js';
import { fakeHap, FakePlatformAccessory } from './fake-hap.js';
import { buildV1Frame } from './frame-builder.js';
import { fakeApi, silentLog } from './helpers.js';

const home = JSON.parse(readFileSync(new URL('./fixtures/home-data.json', import.meta.url), 'utf8')) as HomeData;
const session: StoredSession = {
  email: 'user@example.com',
  clientId: 'client-1',
  region: { baseUrl: 'https://usiot.roborock.com', country: 'US', countryCode: '1' },
  userData: { token: 'tok', rriot: { u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { a: 'https://api-us.roborock.com', m: 'ssl://mqtt-us.roborock.com:8883' } } },
};
const TOPIC = 'rr/m/o/u1/b7b04791/mower-duid';

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

interface StartOptions {
  session?: StoredSession;
  connectMqtt?: () => FakeMqttClient;
  config?: Record<string, unknown>;
  homeResponse?: () => object | Response;
  cached?: FakePlatformAccessory[];
}

function start(options: StartOptions = {}) {
  const { api, accessories, emit, storagePath } = fakeApi();
  const { fetch, calls } = fakeFetch({
    '/api/v1/getHomeDetail': { code: 200, data: { rrHomeId: 42 } },
    '/v3/user/homes/42': () => (options.homeResponse ?? (() => ({ success: true, result: home })))(),
  });
  const client = new FakeMqttClient();
  const clock = { now: 1_700_000_000_000 };
  const platform = new RoborockMowerPlatform(silentLog, { platform: PLATFORM_NAME, sensorDebounceSeconds: 0, ...options.config }, api, {
    fetch,
    readSession: async () => options.session,
    connectMqtt: (options.connectMqtt ?? (() => client)) as never,
    now: () => clock.now,
  });
  for (const cached of options.cached ?? []) {
    platform.configureAccessory(cached as unknown as PlatformAccessory);
  }
  emit('didFinishLaunching');
  // The client rate-limits home data (1/s, 3/min, 5/h); each re-sync in tests happens "an hour later".
  const resync = async () => {
    clock.now += 3_600_000;
    await platform.reconcile();
  };
  return { platform, accessories, calls, client, storagePath, resync };
}

const connect = (client: FakeMqttClient) => {
  client.connected = true;
  client.emit('connect');
};

const push = (client: FakeMqttClient, dps: string) => client.emit('message', TOPIC, buildV1Frame(102, 1787457040, `{"t":1787457040,"dps":${dps}}`, 'localkey'));

const withoutMower = { success: true, result: { ...home, devices: [], receivedDevices: home.receivedDevices } };
const empty = { success: true, result: { ...home, devices: [], receivedDevices: [], products: [] } };

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
    const { platform, calls, accessories } = start();
    await platform.whenStarted();
    assert.equal(calls.length, 0);
    assert.equal(accessories.length, 0);
  });

  test('makes exactly one home-data call, registers the mower, seeds its state, subscribes it and writes status.json', async () => {
    const { platform, calls, accessories, client, storagePath } = start({ session });
    await platform.whenStarted();
    connect(client);
    assert.deepEqual(calls.map((c) => c.url.pathname), ['/api/v1/getHomeDetail', '/v3/user/homes/42']);
    assert.equal(accessories.length, 1);
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('ContactSensorState'), 0);
    assert.equal(accessories[0].find(fakeHap.Service.Battery)?.value('BatteryLevel'), 100);
    assert.deepEqual(client.subscriptions, [TOPIC]);
    const status = await readStatus(storagePath);
    assert.equal(status?.devices[0]?.name, 'RockMow X120H LiDAR');
    assert.equal('localKey' in (status?.devices[0] ?? {}), false);
  });

  test('sensors are inactive until the broker is connected, and active after', async () => {
    const { platform, accessories, client } = start({ session });
    await platform.whenStarted();
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('StatusActive'), false);
    connect(client);
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('StatusActive'), true);
  });

  test('when the cloud is down at boot, cached mowers still get MQTT and the cloud is retried later', async () => {
    const cached = new FakePlatformAccessory('RockMow X120H LiDAR', 'uuid-mower-duid');
    cached.context = { device: { duid: 'mower-duid', name: 'RockMow X120H LiDAR', model: 'roborock.mower.a282', localKey: 'localkey' } };
    const { platform, client, calls } = start({ session, cached: [cached], homeResponse: () => new Response('', { status: 500 }) });
    await platform.whenStarted();
    assert.deepEqual(client.subscriptions, [], 'not connected yet');
    connect(client);
    assert.deepEqual(client.subscriptions, [TOPIC]);
    assert.equal(calls.filter((c) => c.url.pathname === '/v3/user/homes/42').length, 1);
    push(client, '{"123":51,"127":0}');
    assert.equal(cached.find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 1);
  });

  test('still registers the mower when MQTT cannot start', async () => {
    const connectMqtt = () => {
      throw new Error('boom');
    };
    const { platform, accessories } = start({ session, connectMqtt });
    await platform.whenStarted();
    assert.equal(accessories.length, 1);
  });

  test('clamps a malformed pollInterval instead of polling every millisecond', () => {
    const { platform } = start({ session, config: { pollInterval: '1h' } });
    assert.equal(platform.pollSeconds(), 3600);
  });
});

describe('RoborockMowerPlatform re-sync', () => {
  test('a mower absent from a successful sync is removed, whatever else the account lists', async () => {
    let response: object = { success: true, result: home };
    const { platform, accessories, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    response = withoutMower;
    await resync();
    assert.equal(accessories.length, 0);
    assert.equal(platform.accessories.size, 0);
  });

  test('a failed sync never removes anything', async () => {
    let response: object | Response = { success: true, result: home };
    const { platform, accessories, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    response = new Response('', { status: 503 });
    await resync();
    assert.equal(accessories.length, 1, 'a 503 is no information');
    response = empty;
    await resync();
    assert.equal(accessories.length, 0, 'an empty list on a 200 is a real absence');
  });

  test('a cloud snapshot does not overwrite fresher push state while connected', async () => {
    const { platform, accessories, client, resync } = start({ session });
    await platform.whenStarted();
    connect(client);
    push(client, '{"123":51,"127":0}');
    await resync(); // fixture snapshot says idle/charge-complete
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 1);
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('ContactSensorState'), 1);
  });

  test('a rename in the Roborock app propagates to the accessory', async () => {
    let response: object = { success: true, result: home };
    const { platform, accessories, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    response = { success: true, result: { ...home, devices: [{ ...home.devices[0], name: 'Front Lawn' }] } };
    await resync();
    assert.equal(accessories[0].displayName, 'Front Lawn');
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('Name'), 'Front Lawn Docked');
  });

  test('an expired session is recorded in status.json for the UI', async () => {
    let response: object = { success: true, result: home };
    const { platform, storagePath, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    response = new Response('{"code":401}', { status: 401, headers: { date: new Date(1_700_000_000_000 + 3_600_000).toUTCString() } });
    await resync();
    assert.equal((await readStatus(storagePath))?.lastError, 'session-expired');
  });
});

describe('RoborockMowerPlatform live updates', () => {
  test('a DPS push flips the sensors: 51 opens Leaving and clears Docked', async () => {
    const { platform, accessories, client } = start({ session });
    await platform.whenStarted();
    push(client, '{"123":51,"127":0}');
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 1);
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('ContactSensorState'), 1);
  });

  test('losing the broker marks sensors inactive; reconnecting restores them without a cloud call', async () => {
    const { platform, accessories, calls, client } = start({ session });
    await platform.whenStarted();
    connect(client);
    client.connected = false;
    client.emit('close');
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('StatusActive'), false);
    connect(client);
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('StatusActive'), true);
    assert.equal(calls.length, 2);
  });
});
