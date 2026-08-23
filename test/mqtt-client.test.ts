import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';

import { mqttCredentials, RoborockMqtt } from '../src/roborock/mqtt-client.js';
import { silentLog } from './helpers.js';

const rriot = { u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { m: 'ssl://mqtt-us-2.roborock.com:8883' } };

class FakeClient extends EventEmitter {
  connected = false;
  internalListeners = 0;
  subscribed: string[] = [];
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
  end() {
    this.ended = true;
    return this;
  }
}

describe('mqttCredentials', () => {
  test('derives username/password from rriot the way the Roborock app does', () => {
    // md5hex("u1:k1")[2:10] and md5hex("s1:k1")[16:]
    const creds = mqttCredentials(rriot);
    assert.deepEqual(creds, { url: 'ssl://mqtt-us-2.roborock.com:8883', username: 'b7b04791', password: '10d865369d871241' });
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
    clients[1].connected = true;
    clients[1].emit('connect');
    clients[0].emit('close'); // the old socket dies after the new one is already up
    assert.deepEqual(seen, [true], 'no false disconnect from the replaced client');
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
