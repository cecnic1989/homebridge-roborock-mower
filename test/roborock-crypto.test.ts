import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hawkAuthorization, headerClientId } from '../src/roborock/crypto.js';

// Vectors computed from the python-roborock formulas; a mismatch here means Roborock returns 401.
const rriot = { u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { a: 'https://api-us.roborock.com' } };
const fixed = { nonce: 'abcdef', timestamp: 1700000000 };

describe('headerClientId', () => {
  test('is base64 of the raw md5 digest (not the hex string) of email + clientId', () => {
    assert.equal(headerClientId('user@example.com', 'client-1'), 'CJa1SGyw5vui6zys1mRwzQ==');
  });
});

describe('hawkAuthorization', () => {
  test('signs path with empty params/payload fields', () => {
    const header = hawkAuthorization(rriot, '/v3/user/homes/42', fixed);
    assert.equal(header, 'Hawk id="u1",s="s1",ts="1700000000",nonce="abcdef",mac="Kvz68G5k7qgCv+fXyLk8uGHZMFj+n6FnsbGhT2y5RUw="');
  });

  test('hashes sorted query params and compact JSON body into the mac', () => {
    const header = hawkAuthorization(rriot, '/v3/user/homes/42', { ...fixed, params: { b: '2', a: '1' }, body: { x: 1, y: 'z' } });
    assert.match(header, /mac="6BRFTWuaA3ulpojYMpr5Nkf\/CZP77tUbIYekmeSgz\/o="$/);
  });
});
