import { encodeV1Frame } from '../src/roborock/v1-protocol.js';

// Test frames use the src encoder so encode and decode are exercised against each other.
export function buildV1Frame(protocol: number, timestamp: number, json: string, localKey: string): Buffer {
  return encodeV1Frame(protocol, timestamp, json, localKey, 5538412, 2959);
}
