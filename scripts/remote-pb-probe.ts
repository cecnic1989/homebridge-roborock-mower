// Dev spike: send ONE remote_pb app-button command to the mower and print what comes back.
// Usage: npx tsx scripts/remote-pb-probe.ts <MOW_EDGE|MOW_GLOBAL|MOW_PAUSE|MOW_RESUME|MOW_END|CHARGE> [--dry-run]
// Wire format from python-roborock v1_protocol.py; verbs from the community RockNeo integration (see CONTRIBUTING.md).
import { readFile } from 'node:fs/promises';

import mqtt from 'mqtt';

import { buildV1Frame } from '../test/frame-builder.js';
import { md5hex, randomAlphanumeric } from '../src/roborock/crypto.js';
import { findMowers } from '../src/roborock/mower.js';
import type { StoredSession } from '../src/roborock/types.js';
import { decodeFrames } from '../src/roborock/v1-protocol.js';
import { RoborockWebApi } from '../src/roborock/web-api.js';

const ALLOWED = new Set(['MOW_EDGE', 'MOW_GLOBAL', 'MOW_PAUSE', 'MOW_RESUME', 'MOW_END', 'CHARGE']);
const PROTOCOL_RPC_REQUEST = 101;
const LISTEN_MS = 90_000;

const [button, flag] = process.argv.slice(2);
const dryRun = flag === '--dry-run';
if (!button || !ALLOWED.has(button)) {
  console.error(`usage: remote-pb-probe <${[...ALLOWED].join('|')}> [--dry-run]`);
  process.exit(2);
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

const { u, s, k, r } = session.userData.rriot;
const user = md5hex(`${u}:${k}`).slice(2, 10);
const password = md5hex(`${s}:${k}`).slice(16);
const outTopic = `rr/m/o/${u}/${user}/${mower.duid}`;
const inTopic = `rr/m/i/${u}/${user}/${mower.duid}`;

// Request: dps.101 carries the JSON-encoded RPC; params is the RemoteMsg in protobufjs toJSON form (string enum names).
const requestId = 10_000 + Math.floor(Math.random() * 22_767);
const timestamp = Math.floor(Date.now() / 1000);
const rpc = { id: requestId, method: 'remote_pb', params: { id: String(Date.now()), type: 'APP_BUTTON', app_button: button } };
const payload = JSON.stringify({ dps: { '101': JSON.stringify(rpc) }, t: timestamp });
const frame = buildV1Frame(PROTOCOL_RPC_REQUEST, timestamp, payload, localKey);
console.log(`request id=${requestId} -> ${inTopic}`);
console.log(`payload ${payload}`);
console.log(`frame ${frame.length} bytes, hex ${frame.toString('hex').slice(0, 60)}…`);
if (dryRun) {
  console.log('dry run: not connecting, not publishing');
  process.exit(0);
}

const started = Date.now();
const rel = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
const client = mqtt.connect(r.m!, { clientId: `${user}-${randomAlphanumeric(6)}`, username: user, password, keepalive: 30, clean: true });

client.on('connect', () => {
  console.log(`${rel()} connected`);
  client.subscribe(outTopic, { qos: 0 }, (err) => {
    if (err) {
      console.log(`subscribe error ${err.message}`);
      return;
    }
    console.log(`${rel()} subscribed; publishing ${button}`);
    client.publish(inTopic, frame, { qos: 0 }, (pubErr) => console.log(pubErr ? `publish error ${pubErr.message}` : `${rel()} published`));
  });
});
client.on('error', (err) => console.log(`${rel()} error ${err.message}`));
client.on('close', () => console.log(`${rel()} closed`));
client.on('message', (_topic, buf) => {
  for (const f of decodeFrames(buf, localKey)) {
    const text = f.payload.toString('utf8');
    let parsed: { dps?: Record<string, unknown> } | undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(`${rel()} proto=${f.protocol} ${f.payload.length} bytes (binary)`);
      continue;
    }
    const rpcReply = parsed?.dps?.['102'];
    if (typeof rpcReply === 'string') {
      console.log(`${rel()} RPC reply: ${rpcReply}${rpcReply.includes(`"id":${requestId}`) ? '   <-- ours' : ''}`);
    } else {
      console.log(`${rel()} proto=${f.protocol} ${text}`);
    }
  }
});

setTimeout(() => {
  console.log(`${rel()} done listening`);
  client.end(true);
  process.exit(0);
}, LISTEN_MS);
