// Dev probe: subscribe to the mower's cloud MQTT topic and print every decoded frame.
// Usage: npx tsx scripts/mqtt-probe.ts   (needs hbConfig/roborock-mower/session.json)
import { readFile } from 'node:fs/promises';

import mqtt from 'mqtt';

import { md5hex } from '../src/roborock/crypto.js';
import { findMowers } from '../src/roborock/mower.js';
import type { StoredSession } from '../src/roborock/types.js';
import { decodeFrames, PROTOCOL_DPS_PUSH } from '../src/roborock/v1-protocol.js';
import { RoborockWebApi } from '../src/roborock/web-api.js';

function printFrames(buf: Buffer, localKey: string): void {
  for (const frame of decodeFrames(buf, localKey)) {
    const text = frame.protocol === PROTOCOL_DPS_PUSH ? frame.payload.toString('utf8') : `${frame.payload.length} bytes (binary)`;
    console.log(`  frame seq=${frame.seq} ts=${frame.timestamp} proto=${frame.protocol}: ${text}`);
  }
}

const session = JSON.parse(await readFile('hbConfig/roborock-mower/session.json', 'utf8')) as StoredSession;
const api = new RoborockWebApi({ email: session.email, clientId: session.clientId, region: session.region });
const home = await api.getHomeData(session.userData, await api.getHomeId(session.userData));
const mower = findMowers(home)[0];
if (!mower?.localKey) {
  throw new Error('no mower with localKey found');
}
console.log(`[${new Date().toISOString()}] seed ${mower.name} online=${mower.online} status=${JSON.stringify(mower.deviceStatus)}`);
const product = home.products.find((p) => p.id === mower.productId) as { schema?: { id: number }[] } | undefined;
const interesting = product?.schema?.filter((entry) => [123, 127, 128, 134, 143].includes(Number(entry.id)));
console.log(`schema for 123/127/128/134/143: ${JSON.stringify(interesting)}`);

const { u, s, k, r } = session.userData.rriot;
const user = md5hex(`${u}:${k}`).slice(2, 10);
const password = md5hex(`${s}:${k}`).slice(16);
const topic = `rr/m/o/${u}/${user}/${mower.duid}`;
console.log(`connecting ${r.m} as ${user}, topic ${topic}`);

const client = mqtt.connect(r.m!, { clientId: user, username: user, password, keepalive: 30, clean: true });
let lastAt: number | undefined;
client.on('connect', () => {
  console.log(`[${new Date().toISOString()}] connected`);
  client.subscribe(topic, { qos: 0 }, (err) => console.log(err ? `subscribe error ${err.message}` : 'subscribed'));
});
client.on('reconnect', () => console.log(`[${new Date().toISOString()}] reconnecting`));
client.on('close', () => console.log(`[${new Date().toISOString()}] closed`));
client.on('error', (err) => console.log(`[${new Date().toISOString()}] error ${err.message}`));
client.on('message', (t, buf) => {
  console.log(`[${new Date().toISOString()}] message on ${t} (${buf.length} bytes) hex=${buf.toString('hex').slice(0, 60)}…`);
  printFrames(buf, mower.localKey!);
  const now = Date.now();
  if (lastAt) {
    console.log(`  +${((now - lastAt) / 1000).toFixed(1)}s since last message`);
  }
  lastAt = now;
});
