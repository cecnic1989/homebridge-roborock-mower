import { createCipheriv, createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { encodeTimestamp } from '../src/roborock/v1-protocol.js';

// Builds a "1.0" frame exactly as observed on the wire (19-byte big-endian header, AES-128-ECB body, CRC32 trailer).
export function buildV1Frame(protocol: number, timestamp: number, json: string, localKey: string): Buffer {
  const key = createHash('md5').update(encodeTimestamp(timestamp) + localKey + 'TXdfu$jyZ#TZHsg4').digest();
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const payload = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const header = Buffer.alloc(19);
  header.write('1.0', 0, 'latin1');
  header.writeUInt32BE(5538412, 3);
  header.writeUInt32BE(2959, 7);
  header.writeUInt32BE(timestamp, 11);
  header.writeUInt16BE(protocol, 15);
  header.writeUInt16BE(payload.length, 17);
  const body = Buffer.concat([header, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([body, crc]);
}
