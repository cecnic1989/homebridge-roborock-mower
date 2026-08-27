// Dev spike: find a harmless RPC the mower answers, to serve as an MQTT subscription liveness probe.
// A reply — result OR error — arriving on the rr/m/o topic proves the push subscription end-to-end.
//
// Usage: npx tsx scripts/liveness-probe.ts <candidate> [--dry-run] [--repeat N] [--interval MIN]
//        npx tsx scripts/liveness-probe.ts custom --method <name> --params '<json>' [--dry-run]
//
// Candidates (safest first). Run ONE at a time with the mower DOCKED and supervised; --dry-run first;
// confirm in the Roborock app that state did not change before trying the next.
//   get_prop         method get_prop, params ["get_status"]      (vacuum-style read)
//   get_status       method get_status, params []
//   mow_pref_pb      method remote_pb, params {type: GET_MOW_PREFERENCE_CONFIG}   (CONTRIBUTING.md app surface)
//   mow_pref_method  method get_mow_preference_config, params []
//   bogus            method liveness_noop, params []             (an ERROR reply is a POSITIVE result)
//   ping             raw protocol-2 frame, empty payload         (reply would be protocol 3)
// Sleep assessment: rerun the winner overnight, e.g. --repeat 40 --interval 15
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

import mqtt from 'mqtt';

import { buildV1Frame } from '../test/frame-builder.js';
import { LIVENESS_PROBE } from '../src/mower/commands.js';
import { randomAlphanumeric } from '../src/roborock/crypto.js';
import { findMowers } from '../src/roborock/mower.js';
import { mqttCredentials } from '../src/roborock/mqtt-client.js';
import type { StoredSession } from '../src/roborock/types.js';
import { decodeFrames, PROTOCOL_RPC_REQUEST } from '../src/roborock/v1-protocol.js';
import { RoborockWebApi } from '../src/roborock/web-api.js';

const PROTOCOL_PING_REQUEST = 2;
const REPLY_WINDOW_MS = 30_000;

interface Candidate {
  method: string;
  params: unknown;
}

const CANDIDATES: Record<string, () => Candidate> = {
  get_prop: () => ({ method: 'get_prop', params: ['get_status'] }),
  get_status: () => ({ method: 'get_status', params: [] }),
  mow_pref_pb: () => ({ method: 'remote_pb', params: { id: String(Date.now()), type: 'GET_MOW_PREFERENCE_CONFIG' } }),
  mow_pref_method: () => ({ method: 'get_mow_preference_config', params: [] }),
  bogus: () => ({ ...LIVENESS_PROBE }), // the exact request production ships, so a rename cannot drift
};

const args = process.argv.slice(2);
const name = args[0];
const dryRun = args.includes('--dry-run');
const flag = (key: string) => {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
};
const repeat = Number(flag('--repeat') ?? 1);
const intervalMin = Number(flag('--interval') ?? 15);
if (!Number.isFinite(repeat) || repeat < 1 || !Number.isFinite(intervalMin) || intervalMin <= 0) {
  // A NaN interval would become setInterval(…, 1ms) and blast every probe at the mower within milliseconds.
  console.error('--repeat and --interval must be positive numbers');
  process.exit(2);
}

const known = name !== undefined && (name === 'ping' || name === 'custom' || Object.hasOwn(CANDIDATES, name));
if (!known || (name === 'custom' && !flag('--method'))) {
  console.error(`usage: liveness-probe <${[...Object.keys(CANDIDATES), 'ping', 'custom'].join('|')}> [--dry-run] [--repeat N] [--interval MIN]`);
  process.exit(2);
}
const candidate = name === 'ping'
  ? undefined
  : name === 'custom'
    ? { method: flag('--method')!, params: JSON.parse(flag('--params') ?? '[]') as unknown }
    : CANDIDATES[name]();

// Empty payload: encodeV1Frame cannot build this (AES padding), so assemble header+CRC by hand.
function buildPingFrame(timestamp: number): Buffer {
  const header = Buffer.alloc(19);
  header.write('1.0', 0, 'latin1');
  header.writeUInt32BE(timestamp, 11);
  header.writeUInt16BE(PROTOCOL_PING_REQUEST, 15);
  header.writeUInt16BE(0, 17);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(header));
  return Buffer.concat([header, crc]);
}

// decodeFrames silently drops frames whose payload will not decrypt (an empty-payload protocol-3 reply
// would vanish there), so log every CRC-valid frame's protocol from the raw header first.
function scanHeaders(buffer: Buffer): { protocol: number; length: number; crcOk: boolean }[] {
  const seen: { protocol: number; length: number; crcOk: boolean }[] = [];
  let offset = 0;
  while (offset + 23 <= buffer.length) {
    const payloadLength = buffer.readUInt16BE(offset + 17);
    const end = offset + 19 + payloadLength;
    if (end + 4 > buffer.length) {
      break;
    }
    seen.push({
      protocol: buffer.readUInt16BE(offset + 15),
      length: payloadLength,
      crcOk: crc32(buffer.subarray(offset, end)) === buffer.readUInt32BE(end),
    });
    offset = end + 4;
  }
  return seen;
}

const session = JSON.parse(await readFile('hbConfig/roborock-mower/session.json', 'utf8')) as StoredSession;
const api = new RoborockWebApi({ email: session.email, clientId: session.clientId, region: session.region });
const home = await api.getHomeData(session.userData, await api.getHomeId(session.userData));
const mower = findMowers(home)[0];
if (!mower?.localKey) {
  throw new Error('no mower with localKey found');
}
const localKey = mower.localKey;
console.log(`[${new Date().toISOString()}] ${mower.name} online=${mower.online} status=${JSON.stringify(mower.deviceStatus)}`);

const { url, username, password } = mqttCredentials(session.userData.rriot);
const outTopic = `rr/m/o/${session.userData.rriot.u}/${username}/${mower.duid}`;
const inTopic = `rr/m/i/${session.userData.rriot.u}/${username}/${mower.duid}`;

interface Attempt {
  id?: number;
  sentAt: number;
  replied: boolean;
}
const attempts: Attempt[] = [];

function buildAttempt(): { frame: Buffer; attempt: Attempt; describe: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  if (!candidate) {
    return { frame: buildPingFrame(timestamp), attempt: { sentAt: Date.now(), replied: false }, describe: 'protocol-2 ping' };
  }
  const id = 10_000 + Math.floor(Math.random() * 22_767);
  const rpc = { id, method: candidate.method, params: candidate.params };
  const payload = JSON.stringify({ dps: { '101': JSON.stringify(rpc) }, t: timestamp });
  return {
    frame: buildV1Frame(PROTOCOL_RPC_REQUEST, timestamp, payload, localKey),
    attempt: { id, sentAt: Date.now(), replied: false },
    describe: payload,
  };
}

const preview = buildAttempt();
console.log(`candidate=${name} -> ${inTopic}`);
console.log(`request ${preview.describe}`);
console.log(`frame ${preview.frame.length} bytes, hex ${preview.frame.toString('hex').slice(0, 60)}…`);
if (dryRun) {
  console.log('dry run: not connecting, not publishing');
  process.exit(0);
}

const started = Date.now();
const rel = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
// reconnectPeriod 0: on any drop we exit instead of silently re-running the connect handler.
const client = mqtt.connect(url, { clientId: `${username}-${randomAlphanumeric(6)}`, username, password, keepalive: 30, clean: true, reconnectPeriod: 0 });
let sent = 0;
let closedWindows = 0;

function sendOne(): void {
  const { frame, attempt, describe } = buildAttempt();
  attempts.push(attempt);
  sent += 1;
  const attemptNo = sent; // the closure below runs 30s later, when `sent` may already be higher
  console.log(`${rel()} [attempt ${attemptNo}/${repeat}] publishing id=${attempt.id ?? 'ping'} ${describe.slice(0, 120)}`);
  client.publish(inTopic, frame, { qos: 0 }, (err) => {
    if (err) {
      console.log(`${rel()} publish error ${err.message}`);
    }
  });
  setTimeout(() => {
    if (!attempt.replied) {
      console.log(`${rel()} [attempt ${attemptNo}] NO REPLY within ${REPLY_WINDOW_MS / 1000}s`);
    }
    closedWindows += 1;
    if (closedWindows >= repeat) { // every attempt's window has closed, not merely been opened
      const ok = attempts.filter((a) => a.replied).length;
      console.log(`${rel()} done: ${ok}/${attempts.length} attempts answered`);
      client.end(true);
      process.exit(ok > 0 ? 0 : 1);
    }
  }, REPLY_WINDOW_MS);
}

client.on('connect', () => {
  console.log(`${rel()} connected`);
  client.subscribe(outTopic, { qos: 0 }, (err) => {
    if (err) {
      console.log(`subscribe error ${err.message}`);
      return;
    }
    console.log(`${rel()} subscribed`);
    sendOne();
    if (repeat > 1) {
      const timer = setInterval(() => {
        if (attempts.length >= repeat) {
          clearInterval(timer);
          return;
        }
        sendOne();
      }, intervalMin * 60_000);
    }
  });
});
client.on('error', (err) => console.log(`${rel()} error ${err.message}`));
client.on('close', () => console.log(`${rel()} closed (no auto-reconnect; rerun to continue)`));
client.on('message', (_topic, buf) => {
  const headers = scanHeaders(buf);
  console.log(`${rel()} frames: ${headers.map((h) => `proto=${h.protocol} len=${h.length}${h.crcOk ? '' : ' BAD-CRC'}`).join(' | ') || 'none parseable'}`);
  // A protocol-3 ping reply has an empty payload that decodeFrames cannot decrypt, so detect it here.
  if (!candidate && headers.some((h) => h.crcOk && h.protocol === 3)) {
    const ping = attempts.find((a) => !a.replied);
    if (ping) {
      ping.replied = true;
      console.log(`${rel()} protocol-3 frame   <-- treating as ping reply ALIVE, ${((Date.now() - ping.sentAt) / 1000).toFixed(1)}s`);
    }
  }
  for (const f of decodeFrames(buf, localKey)) {
    const text = f.payload.toString('utf8');
    let parsed: { dps?: Record<string, unknown> } | undefined;
    try {
      parsed = JSON.parse(text) as { dps?: Record<string, unknown> };
    } catch {
      console.log(`${rel()} proto=${f.protocol} ${f.payload.length} bytes (binary)`);
      continue;
    }
    const rpcReply = parsed?.dps?.['102'];
    if (typeof rpcReply === 'string') {
      let reply: { id?: unknown; error?: unknown } = {};
      try {
        reply = JSON.parse(rpcReply) as { id?: unknown; error?: unknown };
      } catch {
        // leave empty
      }
      const ours = attempts.find((a) => a.id !== undefined && a.id === reply.id);
      if (ours && !ours.replied) {
        ours.replied = true;
        const latency = ((Date.now() - ours.sentAt) / 1000).toFixed(1);
        console.log(`${rel()} RPC reply: ${rpcReply}   <-- ours${reply.error !== undefined ? ' (error reply)' : ''} ALIVE, ${latency}s`);
      } else {
        console.log(`${rel()} RPC reply: ${rpcReply}   (not ours)`);
      }
    } else {
      console.log(`${rel()} proto=${f.protocol} ${text}`);
    }
  }
});
