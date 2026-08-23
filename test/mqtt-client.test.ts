import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { mqttCredentials } from '../src/roborock/mqtt-client.js';

describe('mqttCredentials', () => {
  test('derives username/password from rriot the way the Roborock app does', () => {
    // md5hex("u1:k1")[2:10] and md5hex("s1:k1")[16:]
    const creds = mqttCredentials({ u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { m: 'ssl://mqtt-us-2.roborock.com:8883' } });
    assert.deepEqual(creds, { url: 'ssl://mqtt-us-2.roborock.com:8883', username: 'b7b04791', password: '10d865369d871241' });
  });
});
