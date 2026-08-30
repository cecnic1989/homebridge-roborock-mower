import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, mock, test } from 'node:test';

import { mqttCredentials, RoborockMqtt } from '../src/roborock/mqtt-client.js';
import { buildV1Frame } from './frame-builder.js';
import { silentLog } from './helpers.js';
import { decodeRpcAt, drain, rpcReplyFrame } from './wire.js';

const rriot = { u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { m: 'ssl://mqtt-us-2.roborock.com:8883' } };

class FakeClient extends EventEmitter {
  connected = false;
  internalListeners = 0;
  subscribed: string[] = [];
  published: { topic: string; payload: Buffer }[] = [];
  failSubscribe = false;
  ended = false;
  constructor() {
    super();
    this.on('close', () => {}); // mqtt.js registers its own close handler (clears the connack timer)
    this.internalListeners = this.listenerCount('close');
  }
  subscribe(topic: string, _opts: unknown, cb?: (err?: Error) => void) {
    this.subscribed.push(topic);
    cb?.(this.failSubscribe ? new Error('suback refused') : undefined);
    return this;
  }
  unsubscribe() {
    return this;
  }
  failPublish = false;
  publish(topic: string, payload: Buffer, _opts: unknown, cb?: (err?: Error) => void) {
    this.published.push({ topic, payload });
    cb?.(this.failPublish ? new Error('stream write failed') : undefined);
    return this;
  }
  end() {
    this.ended = true;
    return this;
  }
}

const OUT_TOPIC = 'rr/m/o/u1/b7b04791/duid-1';

function liveMqtt() {
  const client = new FakeClient();
  const mqtt = new RoborockMqtt(rriot, silentLog, ((() => client) as unknown) as never);
  mqtt.subscribe('duid-1', 'localkey', () => {});
  mqtt.start();
  client.connected = true;
  client.emit('connect');
  return { client, mqtt };
}

function decodeRequest(client: FakeClient, index = 0) {
  return { topic: client.published[index].topic, ...decodeRpcAt(client.published, 'localkey', index) };
}

function reply(client: FakeClient, body: object) {
  client.emit('message', OUT_TOPIC, rpcReplyFrame(body, 'localkey', 1787523488));
}

describe('mqttCredentials', () => {
  test('derives username/password from rriot the way the Roborock app does', () => {
    // md5hex("u1:k1")[2:10] and md5hex("s1:k1")[16:]
    const creds = mqttCredentials(rriot);
    assert.deepEqual(creds, { url: 'ssl://mqtt-us-2.roborock.com:8883', username: 'b7b04791', password: '10d865369d871241' });
  });
});

describe('RoborockMqtt RPC', () => {
  test('request publishes a decodable 101 frame on the input topic and resolves on the matching reply', async () => {
    const { client, mqtt } = liveMqtt();
    const pending = mqtt.request('duid-1', 'remote_pb', { type: 'APP_BUTTON', app_button: 'CHARGE' });
    await drain();
    const { topic, frame, rpc } = decodeRequest(client);
    assert.equal(topic, 'rr/m/i/u1/b7b04791/duid-1');
    assert.equal(frame.protocol, 101);
    assert.equal(rpc.method, 'remote_pb');
    assert.deepEqual(rpc.params, { type: 'APP_BUTTON', app_button: 'CHARGE' });
    reply(client, { id: rpc.id, result: ['ok'] });
    assert.deepEqual(await pending, ['ok']);
  });

  test('a frame carrying both an RPC reply and status dps delivers both', async () => {
    const client = new FakeClient();
    const mqtt = new RoborockMqtt(rriot, silentLog, ((() => client) as unknown) as never);
    const pushes: Record<number, unknown>[] = [];
    mqtt.subscribe('duid-1', 'localkey', (dps) => pushes.push(dps));
    mqtt.start();
    client.connected = true;
    client.emit('connect');
    const pending = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_GLOBAL' });
    await drain();
    const { rpc } = decodeRequest(client);
    const ts = 1787523488;
    client.emit('message', OUT_TOPIC, buildV1Frame(102, ts,
      JSON.stringify({ t: ts, dps: { 123: 52, 102: JSON.stringify({ id: rpc.id, result: ['ok'] }) } }), 'localkey'));
    assert.deepEqual(await pending, ['ok']);
    assert.deepEqual(pushes, [{ 123: 52 }], 'the status half of the frame must not be swallowed by the reply');
  });

  test('a reply on another mower of the account cannot settle this one, even with the same id', async () => {
    const { client, mqtt } = liveMqtt();
    mqtt.subscribe('duid-2', 'otherkey', () => {});
    const pending = mqtt.request('duid-1', 'remote_pb', { app_button: 'CHARGE' });
    await drain();
    const { rpc } = decodeRequest(client);
    client.emit('message', 'rr/m/o/u1/b7b04791/duid-2',
      rpcReplyFrame({ id: rpc.id, result: ['nope'] }, 'otherkey', 1787523488));
    let settled = false;
    void pending.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await drain();
    assert.equal(settled, false, 'a different mower answered; ours is still pending');
    reply(client, { id: rpc.id, result: ['ok'] });
    assert.deepEqual(await pending, ['ok']);
  });

  test('a reply carrying an error rejects; a foreign reply is ignored', async () => {
    const { client, mqtt } = liveMqtt();
    const pending = mqtt.request('duid-1', 'remote_pb', { type: 'APP_BUTTON', app_button: 'MOW_PAUSE' });
    await drain();
    const { rpc } = decodeRequest(client);
    reply(client, { id: rpc.id + 1, result: ['ok'] }); // someone else's request
    reply(client, { id: rpc.id, error: { code: -10007, message: 'invalid status' } });
    await assert.rejects(pending, /invalid status|-10007/);
  });

  test('times out when the mower never answers', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { mqtt } = liveMqtt();
      const pending = mqtt.request('duid-1', 'remote_pb', { type: 'APP_BUTTON', app_button: 'CHARGE' });
      pending.catch(() => undefined);
      await drain();
      mock.timers.tick(10_000);
      await assert.rejects(pending, /timed out/);
    } finally {
      mock.timers.reset();
    }
  });

  test('rejects without publishing when not connected or not subscribed', async () => {
    const client = new FakeClient();
    const mqtt = new RoborockMqtt(rriot, silentLog, ((() => client) as unknown) as never);
    mqtt.subscribe('duid-1', 'localkey', () => {});
    mqtt.start(); // never connects
    await assert.rejects(mqtt.request('duid-1', 'remote_pb', {}), /not connected/i);
    client.connected = true;
    client.emit('connect');
    await assert.rejects(mqtt.request('duid-other', 'remote_pb', {}), /subscription/i);
    assert.equal(client.published.length, 0);
  });

  test('a second request for the same mower waits for the first to settle', async () => {
    const { client, mqtt } = liveMqtt();
    const first = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_PAUSE' });
    const second = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_RESUME' });
    await drain();
    assert.equal(client.published.length, 1, 'second request queued behind the first');
    reply(client, { id: decodeRequest(client).rpc.id, result: ['ok'] });
    await first;
    await drain();
    const { rpc } = decodeRequest(client, 1);
    assert.equal(rpc.params.app_button, 'MOW_RESUME');
    reply(client, { id: rpc.id, result: ['ok'] });
    await second;
  });

  test('rapid re-commands supersede a queued one instead of replaying stale intents later', async () => {
    const { client, mqtt } = liveMqtt();
    const first = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_GLOBAL' });
    const second = mqtt.request('duid-1', 'remote_pb', { app_button: 'CHARGE' });
    const third = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_GLOBAL' });
    await drain();
    await assert.rejects(second, /superseded/i, 'the queued dock was replaced by a newer command');
    reply(client, { id: decodeRequest(client).rpc.id, result: ['ok'] });
    await first;
    await drain();
    assert.equal(client.published.length, 2, 'only the newest queued command went out');
    reply(client, { id: decodeRequest(client, 1).rpc.id, result: ['ok'] });
    await third;
  });

  test('unsubscribing a mower fails its in-flight command at once instead of a 10s spinner', async () => {
    const { mqtt } = liveMqtt();
    const pending = mqtt.request('duid-1', 'remote_pb', { app_button: 'CHARGE' });
    pending.catch(() => undefined);
    await drain();
    mqtt.unsubscribe('duid-1');
    await assert.rejects(pending, /no longer|removed|unsubscribed/i);
  });

  test('restart() rejects a pending request instead of leaving it hanging', async () => {
    const { mqtt } = liveMqtt();
    const pending = mqtt.request('duid-1', 'remote_pb', { app_button: 'CHARGE' });
    pending.catch(() => undefined);
    await drain(); // the request is now on the wire, waiting for a reply
    mqtt.restart();
    await assert.rejects(pending, /connection closed/i);
  });
});

describe('RoborockMqtt liveness probe', () => {
  test('a probe skips while a command is queued, and the queued command survives un-superseded', async () => {
    const { client, mqtt } = liveMqtt();
    const first = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_GLOBAL' });
    const queued = mqtt.request('duid-1', 'remote_pb', { app_button: 'CHARGE' });
    const outcome = await mqtt.probe('duid-1', 'liveness_noop', []);
    assert.equal(outcome, 'skipped', 'the probe must not enter the one-slot queue');
    await drain();
    reply(client, { id: decodeRequest(client).rpc.id, result: ['ok'] });
    await first;
    await drain();
    assert.equal(decodeRequest(client, 1).rpc.params.app_button, 'CHARGE', 'the queued dock still went out');
    reply(client, { id: decodeRequest(client, 1).rpc.id, result: ['ok'] });
    await queued;
  });

  test('an error reply settles the probe as alive: a delivered frame proves the subscription', async () => {
    const { client, mqtt } = liveMqtt();
    const outcome = mqtt.probe('duid-1', 'liveness_noop', []);
    await drain();
    reply(client, { id: decodeRequest(client).rpc.id, error: { code: -1, message: 'unknown' } });
    assert.equal(await outcome, 'alive');
  });

  test('a probe timeout resolves dead without rejecting', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { mqtt } = liveMqtt();
      const outcome = mqtt.probe('duid-1', 'liveness_noop', []);
      await drain();
      mock.timers.tick(10_000);
      assert.equal(await outcome, 'dead');
    } finally {
      mock.timers.reset();
    }
  });

  test('a user command issued while a probe is in flight publishes immediately', async () => {
    const { client, mqtt } = liveMqtt();
    const outcome = mqtt.probe('duid-1', 'liveness_noop', []);
    await drain();
    const command = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_PAUSE' });
    await drain();
    assert.equal(client.published.length, 2, 'the probe must not hold the command slot');
    reply(client, { id: decodeRequest(client, 1).rpc.id, result: ['ok'] });
    await command;
    reply(client, { id: decodeRequest(client).rpc.id, result: 'unknown_method' });
    assert.equal(await outcome, 'alive');
  });

  test('a restart mid-probe resolves skipped, not dead: no strike from our own teardown', async () => {
    const { mqtt } = liveMqtt();
    const outcome = mqtt.probe('duid-1', 'liveness_noop', []);
    await drain();
    mqtt.restart();
    assert.equal(await outcome, 'skipped');
  });

  test('a command overlapping a probe never reuses its RPC id, so neither reply can settle the wrong request', async () => {
    mock.method(Math, 'random', () => 0.5); // every draw collides unless the id is re-rolled
    try {
      const { client, mqtt } = liveMqtt();
      const probe = mqtt.probe('duid-1', 'liveness_noop', []);
      await drain();
      const command = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_GLOBAL' });
      await drain();
      const probeId = decodeRequest(client, 0).rpc.id;
      const commandId = decodeRequest(client, 1).rpc.id;
      assert.notEqual(probeId, commandId, 'two pending requests for one mower must not share an id');
      reply(client, { id: probeId, result: 'unknown_method' });
      reply(client, { id: commandId, result: ['ok'] });
      assert.equal(await probe, 'alive');
      assert.deepEqual(await command, ['ok'], 'the probe reply must not have settled the user command');
    } finally {
      mock.restoreAll();
    }
  });

  test('a successor that throws while starting cannot hijack the predecessor\'s result or hang itself', async () => {
    const { client, mqtt } = liveMqtt();
    const first = mqtt.request('duid-1', 'remote_pb', { app_button: 'MOW_GLOBAL' });
    const second = mqtt.request('duid-1', 'remote_pb', () => {
      throw new Error('encode failed'); // the thunk runs synchronously inside the queue's settle path
    });
    const secondFailure = assert.rejects(second, /encode failed/);
    await drain();
    reply(client, { id: decodeRequest(client).rpc.id, result: ['ok'] });
    assert.deepEqual(await first, ['ok'], 'the first command keeps its own result');
    await secondFailure;
  });

  test('a local publish failure resolves skipped, not dead: it never tested the subscription', async () => {
    const { client, mqtt } = liveMqtt();
    client.failPublish = true;
    assert.equal(await mqtt.probe('duid-1', 'liveness_noop', []), 'skipped');
  });

  test('onFrame fires for any decodable frame of a subscribed mower, including a foreign reply', () => {
    const { client, mqtt } = liveMqtt();
    const seen: string[] = [];
    mqtt.onFrame((duid) => seen.push(duid));
    reply(client, { id: 31999, result: ['ok'] }); // another client's reply on the shared account topic
    assert.deepEqual(seen, ['duid-1']);
  });
});

describe('RoborockMqtt connection events', () => {
  test('reports only transitions: repeated close events during an outage collapse to one', () => {
    const client = new FakeClient();
    const mqtt = new RoborockMqtt(rriot, silentLog, (() => client) as never);
    const seen: boolean[] = [];
    mqtt.onConnectionChange((c) => seen.push(c));
    mqtt.start();
    client.connected = true;
    client.emit('connect');
    client.connected = false;
    client.emit('close');
    client.emit('close');
    client.emit('offline');
    client.connected = true;
    client.emit('connect');
    assert.deepEqual(seen, [true, false, true]);
  });

  test('resubscribe() re-issues every topic; a refused subscribe tears the client down and reconnects', () => {
    const clients: FakeClient[] = [];
    const connect = () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    };
    const mqtt = new RoborockMqtt(rriot, silentLog, (connect as unknown) as never);
    mqtt.subscribe('duid-1', 'key', () => {});
    mqtt.start();
    clients[0].connected = true;
    clients[0].emit('connect');
    assert.equal(clients[0].subscribed.length, 1);

    mqtt.resubscribe();
    assert.equal(clients[0].subscribed.length, 2, 'resubscribe re-issues the SUBSCRIBE');

    clients[0].failSubscribe = true;
    mqtt.resubscribe();
    assert.equal(clients[0].ended, true, 'a refused subscribe means the session is broken');
    assert.equal(clients.length, 2, 'a fresh client replaces it');
    clients[1].connected = true;
    clients[1].emit('connect');
    assert.deepEqual(clients[1].subscribed, clients[0].subscribed.slice(0, 1), 'the new session subscribes the same topic');
  });

  test('a refused subscribe at connect time also restarts, but repeated refusals do not spin', () => {
    const clients: FakeClient[] = [];
    const connect = () => {
      const c = new FakeClient();
      c.failSubscribe = true;
      clients.push(c);
      return c;
    };
    const mqtt = new RoborockMqtt(rriot, silentLog, (connect as unknown) as never);
    mqtt.subscribe('duid-1', 'key', () => {});
    mqtt.start();
    clients[0].connected = true;
    clients[0].emit('connect'); // suback refused right at connect
    assert.equal(clients.length, 2, 'refusal at connect is the same broken session');
    clients[1].connected = true;
    clients[1].emit('connect'); // refused again straight away
    assert.equal(clients.length, 2, 'a second refusal within the cooldown must not spin restarts');
  });

  test('a live connection re-subscribes on its own timer, without any cloud traffic', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const client = new FakeClient();
    const mqtt = new RoborockMqtt(rriot, silentLog, ((() => client) as unknown) as never);
    mqtt.subscribe('duid-1', 'key', () => {});
    mqtt.start();
    client.connected = true;
    client.emit('connect');
    const after = client.subscribed.length;
    mock.timers.tick(15 * 60_000);
    assert.equal(client.subscribed.length, after + 1);
    mock.timers.reset();
  });

  test('restart() replaces the connection and a late close from the old client is ignored', () => {
    const clients: FakeClient[] = [];
    const connect = () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    };
    const mqtt = new RoborockMqtt(rriot, silentLog, (connect as unknown) as never);
    const seen: boolean[] = [];
    mqtt.onConnectionChange((c) => seen.push(c));
    mqtt.start();
    clients[0].connected = true;
    clients[0].emit('connect');
    mqtt.restart();
    assert.equal(clients[0].ended, true);
    assert.deepEqual(seen, [true, false], 'listeners hear the drop while the replacement is still connecting');
    clients[1].connected = true;
    clients[1].emit('connect');
    clients[0].emit('close'); // the old socket dies after the new one is already up
    assert.deepEqual(seen, [true, false, true], 'and no extra disconnect from the replaced client');
  });

  test('stop() leaves mqtt.js internal listeners in place and absorbs a late error', () => {
    const client = new FakeClient();
    const mqtt = new RoborockMqtt(rriot, silentLog, (() => client) as never);
    const seen: boolean[] = [];
    mqtt.onConnectionChange((c) => seen.push(c));
    mqtt.start();
    mqtt.stop();
    assert.equal(client.listenerCount('close') >= client.internalListeners, true);
    assert.doesNotThrow(() => client.emit('error', new Error('connack timeout')));
    client.connected = true;
    client.emit('connect');
    assert.deepEqual(seen, [], 'a stopped client must not report a connection');
  });
});
