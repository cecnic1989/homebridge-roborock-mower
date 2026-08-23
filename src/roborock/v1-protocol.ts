import { createDecipheriv, createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

// Wire format of Roborock "1.0" devices over cloud MQTT (big-endian):
// version(3) seq(4) random(4) timestamp(4) protocol(2) payloadLen(2) payload crc32(4)
const HEADER_LENGTH = 19;
const CRC_LENGTH = 4;
const SALT = 'TXdfu$jyZ#TZHsg4';
const RPC_DPS_KEYS = new Set([101, 102]);

export const PROTOCOL_DPS_PUSH = 102;

export interface DecodedFrame {
  protocol: number;
  timestamp: number;
  seq: number;
  payload: Buffer;
}

// The device reorders the 8 hex digits of the unix timestamp to derive the per-message key.
export function encodeTimestamp(timestamp: number): string {
  const hex = timestamp.toString(16).padStart(8, '0');
  return [5, 6, 3, 7, 1, 2, 0, 4].map((i) => hex[i]).join('');
}

function messageKey(timestamp: number, localKey: string): Buffer {
  return createHash('md5').update(encodeTimestamp(timestamp) + localKey + SALT).digest();
}

// Protocol mandated by the device; ECB is Roborock's choice, not ours.
function decrypt(payload: Buffer, localKey: string, timestamp: number): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', messageKey(timestamp, localKey), null);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

// One MQTT message can carry several frames; frames with a bad CRC or undecryptable payload are skipped.
export function decodeFrames(buffer: Buffer, localKey: string): DecodedFrame[] {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (offset + HEADER_LENGTH + CRC_LENGTH <= buffer.length) {
    const payloadLength = buffer.readUInt16BE(offset + 17);
    const end = offset + HEADER_LENGTH + payloadLength;
    if (end + CRC_LENGTH > buffer.length) {
      break;
    }
    const next = end + CRC_LENGTH;
    if (crc32(buffer.subarray(offset, end)) !== buffer.readUInt32BE(end)) {
      offset = next;
      continue;
    }
    const timestamp = buffer.readUInt32BE(offset + 11);
    try {
      frames.push({
        protocol: buffer.readUInt16BE(offset + 15),
        timestamp,
        seq: buffer.readUInt32BE(offset + 3),
        payload: decrypt(buffer.subarray(offset + HEADER_LENGTH, end), localKey, timestamp),
      });
    } catch {
      // wrong key or padding: not for us
    }
    offset = next;
  }
  return frames;
}

// Status pushes look like {"t":1787457039,"dps":{"123":51}}. Keys 101/102 carry RPC traffic on the same topic.
export function parseDpsPush(payload: Buffer): Record<number, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return undefined;
  }
  const dps = (parsed as { dps?: unknown } | null)?.dps;
  if (!dps || typeof dps !== 'object') {
    return undefined;
  }
  const result: Record<number, unknown> = {};
  for (const [key, value] of Object.entries(dps as Record<string, unknown>)) {
    const id = Number(key);
    if (Number.isInteger(id) && !RPC_DPS_KEYS.has(id)) {
      result[id] = value;
    }
  }
  return result;
}
