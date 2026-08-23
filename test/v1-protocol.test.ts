import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decodeFrames, encodeTimestamp, parseDpsPush } from '../src/roborock/v1-protocol.js';
import { buildV1Frame } from './frame-builder.js';

const localKey = 'abcdefghijklmnop';
const buildFrame = (protocol: number, timestamp: number, json: string) => buildV1Frame(protocol, timestamp, json, localKey);

describe('encodeTimestamp', () => {
  test('reorders the 8 hex digits as [5,6,3,7,1,2,0,4]', () => {
    // hex "6a8a6e0f" -> digits at [5,6,3,7,1,2,0,4] = e,0,a,f,a,8,6,6
    assert.equal(encodeTimestamp(0x6a8a6e0f), 'e0afa866');
  });
});

describe('decodeFrames', () => {
  test('decrypts a DPS push frame using the timestamp-derived key', () => {
    const frames = decodeFrames(buildFrame(102, 1787457039, '{"t":1787457039,"dps":{"132":1}}'), localKey);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].protocol, 102);
    assert.equal(frames[0].payload.toString(), '{"t":1787457039,"dps":{"132":1}}');
  });

  test('splits concatenated frames in one MQTT message', () => {
    const buffer = Buffer.concat([buildFrame(102, 1787457040, '{"dps":{"123":51}}'), buildFrame(301, 1787457040, 'map')]);
    const frames = decodeFrames(buffer, localKey);
    assert.deepEqual(frames.map((f) => f.protocol), [102, 301]);
  });

  test('drops a frame whose CRC does not match and keeps decoding the rest', () => {
    const bad = buildFrame(102, 1787457040, '{"dps":{"123":51}}');
    bad[bad.length - 1] ^= 0xff;
    const frames = decodeFrames(Buffer.concat([bad, buildFrame(102, 1787457041, '{"dps":{"123":52}}')]), localKey);
    assert.deepEqual(frames.map((f) => f.payload.toString()), ['{"dps":{"123":52}}']);
  });
});

describe('parseDpsPush', () => {
  test('returns numeric-keyed dps and ignores RPC keys 101/102', () => {
    const dps = parseDpsPush(Buffer.from('{"t":1,"dps":{"123":57,"139":0,"102":"{\\"id\\":1}"}}'));
    assert.deepEqual(dps, { 123: 57, 139: 0 });
  });

  test('returns undefined for non-DPS payloads (protobuf, map, garbage)', () => {
    assert.equal(parseDpsPush(Buffer.from('PB')), undefined);
    assert.equal(parseDpsPush(Buffer.from('{"result":"ok"}')), undefined);
  });
});
