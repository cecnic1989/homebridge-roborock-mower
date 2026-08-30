import { decodeFrames } from '../src/roborock/v1-protocol.js';
import { buildV1Frame } from './frame-builder.js';

// Shared wire-format helpers: the RPC envelope is encoded in exactly one place per direction, so a
// protocol change is one edit instead of a hunt across test files.

// Lets a serialized request pipeline reach the wire between assertions.
export const drain = async (turns = 8): Promise<void> => {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
};

// Decodes the RPC request carried by a published frame (default: the most recent one).
export function decodeRpcAt(published: { payload: Buffer }[], localKey: string, index = published.length - 1) {
  const [frame] = decodeFrames(published[index].payload, localKey);
  const envelope = JSON.parse(frame.payload.toString('utf8')) as { dps: Record<string, string> };
  return { frame, rpc: JSON.parse(envelope.dps['101']) as { id: number; method: string; params: Record<string, unknown> } };
}

// Builds the protocol-102 frame a mower answers with.
export function rpcReplyFrame(body: object, localKey: string, timestamp = 1787457040): Buffer {
  return buildV1Frame(102, timestamp, JSON.stringify({ t: timestamp, dps: { 102: JSON.stringify(body) } }), localKey);
}
