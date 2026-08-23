// Dev spike: send ONE remote_pb app-button command to the mower and print what comes back.
// Usage: npx tsx scripts/remote-pb-probe.ts <MOW_EDGE|MOW_GLOBAL|MOW_PAUSE|MOW_RESUME|MOW_END|CHARGE> [--dry-run]
// Wire format from python-roborock v1_protocol.py; verbs from the community RockNeo integration (see CONTRIBUTING.md).
import { readFile } from 'node:fs/promises';

import mqtt from 'mqtt';

import { buildV1Frame } from '../test/frame-builder.js';
import { randomAlphanumeric } from '../src/roborock/crypto.js';
import { findMowers } from '../src/roborock/mower.js';
import { mqttCredentials } from '../src/roborock/mqtt-client.js';
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

const { url, username, password } = mqttCredentials(session.userData.rriot);
const outTopic = `rr/m/o/${session.userData.rriot.u}/${username}/${mower.duid}`;
const inTopic = `rr/m/i/${session.userData.rriot.u}/${username}/${mower.duid}`;

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
// reconnectPeriod 0: an auto-reconnect would re-run the connect handler and send the physical command again.
const client = mqtt.connect(url, { clientId: `${username}-${randomAlphanumeric(6)}`, username, password, keepalive: 30, clean: true, reconnectPeriod: 0 });
let published = false;

client.on('connect', () => {
  console.log(`${rel()} connected`);
  client.subscribe(outTopic, { qos: 0 }, (err) => {
    if (err) {
      console.log(`subscribe error ${err.message}`);
      return;
    }
    if (published) {
      return; // never send a mow/dock command twice
    }
    published = true;
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
      let replyId: unknown;
      try {
        replyId = (JSON.parse(rpcReply) as { id?: unknown }).id;
      } catch {
        replyId = undefined;
      }
      console.log(`${rel()} RPC reply: ${rpcReply}${replyId === requestId ? '   <-- ours' : ''}`);
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
