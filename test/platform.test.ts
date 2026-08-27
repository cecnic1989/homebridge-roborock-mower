import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { PlatformAccessory } from 'homebridge';

import { RoborockMowerPlatform } from '../src/platform.js';
import { readStatus } from '../src/roborock/session-store.js';
import type { HomeData, StoredSession } from '../src/roborock/types.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { decodeFrames } from '../src/roborock/v1-protocol.js';
import { fakeFetch, type RecordedRequest } from './fake-fetch.js';
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
  unsubscriptions: string[] = [];
  subscribe(topic: string, _opts: unknown, cb?: (err?: Error) => void) {
    this.subscriptions.push(topic);
    cb?.();
    return this;
  }
  unsubscribe(topic: string) {
    this.unsubscriptions.push(topic);
    return this;
  }
  published: { topic: string; payload: Buffer }[] = [];
  publish(topic: string, payload: Buffer, _opts: unknown, cb?: (err?: Error) => void) {
    this.published.push({ topic, payload });
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
  homeResponse?: (req: RecordedRequest) => object | Response;
  cached?: FakePlatformAccessory[];
}

function start(options: StartOptions = {}) {
  const { api, accessories, emit, storagePath } = fakeApi();
  const { fetch, calls } = fakeFetch({
    '/api/v1/getHomeDetail': { code: 200, data: { rrHomeId: 42 } },
    '/v3/user/homes/42': (req) => (options.homeResponse ?? (() => ({ success: true, result: home })))(req),
  });
  const client = new FakeMqttClient();
  const clock = { now: 1_700_000_000_000 };
  const stored = { session: options.session };
  const platform = new RoborockMowerPlatform(silentLog, { platform: PLATFORM_NAME, sensorDebounceSeconds: 0, ...options.config }, api, {
    fetch,
    readSession: async () => stored.session,
    connectMqtt: (options.connectMqtt ?? (() => client)) as never,
    now: () => clock.now,
  });
  for (const cached of options.cached ?? []) {
    platform.configureAccessory(cached as unknown as PlatformAccessory);
  }
  emit('didFinishLaunching');
  // The client rate-limits home data (1/s, 3/min, 5/h); each re-sync in tests happens "an hour later".
  const resync = async (advanceMs = 3_600_000) => {
    clock.now += advanceMs;
    await platform.reconcile();
  };
  return { platform, accessories, calls, client, storagePath, resync, stored };
}

const connect = (client: FakeMqttClient) => {
  client.connected = true;
  client.emit('connect');
};

const push = (client: FakeMqttClient, dps: string, localKey = 'localkey') =>
  client.emit('message', TOPIC, buildV1Frame(102, 1787457040, `{"t":1787457040,"dps":${dps}}`, localKey));

const withoutMower = { success: true, result: { ...home, devices: [], receivedDevices: home.receivedDevices } };
const empty = { success: true, result: { ...home, devices: [], receivedDevices: [], products: [] } };

describe('RoborockMowerPlatform startup', () => {
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

  test('when MQTT cannot start, the mower is still registered and its cloud-fed sensors are active', async () => {
    const connectMqtt = () => {
      throw new Error('boom');
    };
    const { platform, accessories } = start({ session, connectMqtt });
    await platform.whenStarted();
    assert.equal(accessories.length, 1);
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('StatusActive'), true);
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

  test('a malformed home payload is logged and skipped, not thrown out of the timer', async () => {
    let response: object = { success: true, result: home };
    const { platform, accessories, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    response = { success: true, result: null };
    await resync(); // rejecting here would be an unhandled rejection from setInterval in production
    assert.equal(accessories.length, 1);
  });

  test('a mower re-paired with a new localKey is resubscribed so pushes still decrypt', async () => {
    let response: object = { success: true, result: home };
    const { platform, accessories, client, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    connect(client);
    response = { success: true, result: { ...home, devices: [{ ...home.devices[0], localKey: 'newkey' }] } };
    await resync();
    push(client, '{"123":51,"127":0}', 'newkey');
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 1);
  });

  test('a removed mower is unsubscribed and later pushes no longer touch it', async () => {
    let response: object = { success: true, result: home };
    const { platform, accessories, client, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    connect(client);
    const removed = accessories[0];
    response = withoutMower;
    await resync();
    assert.deepEqual(client.unsubscriptions, [TOPIC]);
    push(client, '{"123":51,"127":0}');
    assert.equal(removed.find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 0);
  });

  test('a cloud snapshot does not overwrite push state that is only minutes old', async () => {
    const { platform, accessories, client, resync } = start({ session });
    await platform.whenStarted();
    connect(client);
    push(client, '{"123":51,"127":0}');
    await resync(60_000); // fixture snapshot says idle/charge-complete, but the push is 1 min old
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 1);
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('ContactSensorState'), 1);
  });

  test('a delta-only push history is not "disagreement": the snapshot is merged but MQTT is left alone', async () => {
    const clients: FakeMqttClient[] = [];
    const connectMqtt = () => {
      const c = new FakeMqttClient();
      clients.push(c);
      return c;
    };
    const { platform, accessories, resync } = start({ session, connectMqtt: connectMqtt as never });
    await platform.whenStarted();
    connect(clients[0]);
    push(clients[0], '{"121":97}'); // a push that never carried DPS 123
    await resync();
    assert.equal(clients.length, 1, 'no restart: neither side proved a different state');
    assert.equal(accessories[0].find(fakeHap.Service.Battery)?.value('BatteryLevel'), 100, 'snapshot still merged');
  });

  test('a stale push that agrees on state still gets the snapshot merged, without a restart', async () => {
    const clients: FakeMqttClient[] = [];
    const connectMqtt = () => {
      const c = new FakeMqttClient();
      clients.push(c);
      return c;
    };
    const { platform, accessories, resync } = start({ session, connectMqtt: connectMqtt as never });
    await platform.whenStarted();
    connect(clients[0]);
    push(clients[0], '{"123":0,"121":50}'); // idle at 50%, then hours of silence
    await resync(); // fixture snapshot: idle at 100%
    assert.equal(accessories[0].find(fakeHap.Service.Battery)?.value('BatteryLevel'), 100, 'battery healed from the cloud');
    assert.equal(clients.length, 1, 'agreement is not evidence of a dead subscription');
  });

  test('a broker outage during re-sync does not let the snapshot beat a minute-old push', async () => {
    const { platform, accessories, client, resync } = start({ session });
    await platform.whenStarted();
    connect(client);
    push(client, '{"123":51,"127":0}');
    client.connected = false;
    client.emit('close'); // reconnecting right as the re-sync runs
    await resync(60_000);
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'leaving')?.value('ContactSensorState'), 1);
  });

  test('every re-sync re-issues the MQTT subscription', async () => {
    const { platform, client, resync } = start({ session });
    await platform.whenStarted();
    connect(client);
    assert.deepEqual(client.subscriptions, [TOPIC]);
    await resync();
    assert.deepEqual(client.subscriptions, [TOPIC, TOPIC]);
  });

  test('a dead subscription is healed: after an hour of silence a disagreeing snapshot wins and MQTT reconnects', async () => {
    const clients: FakeMqttClient[] = [];
    const connectMqtt = () => {
      const c = new FakeMqttClient();
      clients.push(c);
      return c;
    };
    const { platform, accessories, resync } = start({ session, connectMqtt: connectMqtt as never });
    await platform.whenStarted();
    connect(clients[0]);
    push(clients[0], '{"123":55,"127":0}'); // mowing... and then the broker silently stops delivering
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'mowing')?.value('ContactSensorState'), 1);
    await resync(); // an hour later the cloud says idle/charge-complete
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'mowing')?.value('ContactSensorState'), 0, 'snapshot applied');
    assert.equal(accessories[0].find(fakeHap.Service.ContactSensor, 'docked')?.value('ContactSensorState'), 0, 'docked again');
    assert.equal(clients.length, 2, 'MQTT connection replaced');
  });

  test('while a mower needs attention and pushes have gone quiet, the next re-sync comes at the 15-min floor', async () => {
    const faulted = {
      success: true,
      result: { ...home, devices: [{ ...home.devices[0], deviceStatus: { ...home.devices[0].deviceStatus, 123: 59 } }] },
    };
    let response: object = { success: true, result: home };
    const { platform, client, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    connect(client);
    assert.equal(platform.nextReconcileSeconds(), 3600);
    push(client, '{"123":59,"127":0}'); // recoverable fault, as pushed in the 2026-08-26 incident...
    assert.equal(platform.nextReconcileSeconds(), 3600, 'a fresh push means MQTT can still deliver the recovery');
    response = faulted;
    await resync(); // ...then an hour of push silence; the cloud agrees it is still faulted
    assert.equal(platform.nextReconcileSeconds(), 900);
    response = { success: true, result: home };
    await resync(); // the mower was rescued: cloud says docked and healthy again
    assert.equal(platform.nextReconcileSeconds(), 3600);
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

  test('a 401 caused by clock skew is not reported as an expired session', async () => {
    let response: object = { success: true, result: home };
    const { platform, storagePath, resync } = start({ session, homeResponse: () => response });
    await platform.whenStarted();
    response = new Response('{"code":401}', { status: 401, headers: { date: new Date(1_700_000_000_000 + 3_600_000 + 300_000).toUTCString() } });
    await resync();
    assert.notEqual((await readStatus(storagePath))?.lastError, 'session-expired');
  });

  test('a new sign-in written by the UI is picked up on the next re-sync without a restart', async () => {
    let validUser = 'u1';
    const { platform, storagePath, resync, stored } = start({
      session,
      homeResponse: (req) => (req.headers.authorization.includes(`id="${validUser}"`)
        ? { success: true, result: home }
        : new Response('{"code":401}', { status: 401 })),
    });
    await platform.whenStarted();
    validUser = 'u2'; // Roborock invalidated the old credentials
    await resync();
    assert.equal((await readStatus(storagePath))?.lastError, 'session-expired');
    stored.session = { ...session, userData: { token: 'tok2', rriot: { ...session.userData.rriot, u: 'u2' } } };
    await resync();
    assert.equal((await readStatus(storagePath))?.lastError, undefined);
  });
});

describe('RoborockMowerPlatform controls', () => {
  const decodeRpc = (client: FakeMqttClient) => {
    const [frame] = decodeFrames(client.published[0].payload, 'localkey');
    const envelope = JSON.parse(frame.payload.toString('utf8')) as { dps: Record<string, string> };
    return JSON.parse(envelope.dps['101']) as { id: number; params: { app_button: string } };
  };

  test('flipping the Mow switch publishes MOW_GLOBAL over remote_pb and resolves on the ok reply', async () => {
    const { platform, accessories, client } = start({ session, config: { exposeControls: true } });
    await platform.whenStarted();
    connect(client);
    const mow = accessories[0].find(fakeHap.Service.Switch, 'mow');
    const setPromise = mow!.triggerSet('On', true);
    for (let i = 0; i < 4; i++) {
      await Promise.resolve(); // let the serialized request reach the wire
    }
    const rpc = decodeRpc(client);
    assert.equal(rpc.params.app_button, 'MOW_GLOBAL');
    assert.equal(client.published[0].topic, 'rr/m/i/u1/b7b04791/mower-duid');
    const ts = 1787523488;
    client.emit('message', TOPIC, buildV1Frame(102, ts, JSON.stringify({ t: ts, dps: { 102: JSON.stringify({ id: rpc.id, result: ['ok'] }) } }), 'localkey'));
    await setPromise;
    assert.equal(mow?.value('On'), true);
  });

  test('without config the switches do not exist; with MQTT down the command fails cleanly', async () => {
    const plain = start({ session });
    await plain.platform.whenStarted();
    assert.equal(plain.accessories[0].services.some((s) => s.type === 'Switch'), false);

    const { platform, accessories, client } = start({ session, config: { exposeControls: true } });
    await platform.whenStarted();
    // broker never connected
    await assert.rejects(accessories[0].find(fakeHap.Service.Switch, 'mow')!.triggerSet('On', true));
    assert.equal(client.published.length, 0);
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
