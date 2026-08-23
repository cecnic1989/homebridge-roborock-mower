import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';

import { mqttCredentials, RoborockMqtt } from '../src/roborock/mqtt-client.js';
import { silentLog } from './helpers.js';

const rriot = { u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { m: 'ssl://mqtt-us-2.roborock.com:8883' } };

class FakeClient extends EventEmitter {
  connected = false;
  subscribe() {
    return this;
  }
  end() {
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
});
