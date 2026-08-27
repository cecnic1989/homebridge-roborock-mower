// E2E smoke: exercise the plugin's OWN RoborockMqtt.probe() + onFrame path against the real broker —
// the same code Homebridge runs, not the hand-built frames of liveness-probe.ts.
// Usage: npx tsx scripts/probe-smoke.ts
import { readFile } from 'node:fs/promises';

import { LIVENESS_PROBE } from '../src/mower/commands.js';
import { findMowers } from '../src/roborock/mower.js';
import { RoborockMqtt } from '../src/roborock/mqtt-client.js';
import type { StoredSession } from '../src/roborock/types.js';
import { RoborockWebApi } from '../src/roborock/web-api.js';

const session = JSON.parse(await readFile('hbConfig/roborock-mower/session.json', 'utf8')) as StoredSession;
const api = new RoborockWebApi({ email: session.email, clientId: session.clientId, region: session.region });
const home = await api.getHomeData(session.userData, await api.getHomeId(session.userData));
const mower = findMowers(home)[0];
if (!mower?.localKey) {
  throw new Error('no mower with localKey found');
}

const log = { debug: () => {}, info: (m: string) => console.log(m), warn: (m: string) => console.log(`WARN ${m}`) };
const mqtt = new RoborockMqtt(session.userData.rriot, log);
let frames = 0;
mqtt.onFrame((duid) => {
  frames += 1;
  console.log(`onFrame fired for ${duid} (frame ${frames})`);
});
mqtt.subscribe(mower.duid, mower.localKey, (dps) => console.log(`push: ${JSON.stringify(dps)}`));
mqtt.start();

await new Promise<void>((resolve) => mqtt.onConnectionChange((c) => c && resolve()));
const started = Date.now();
const outcome = await mqtt.probe(mower.duid, LIVENESS_PROBE.method, LIVENESS_PROBE.params);
console.log(`probe outcome: ${outcome} in ${Date.now() - started}ms, onFrame fired ${frames}x`);
mqtt.stop();
process.exit(outcome === 'alive' && frames > 0 ? 0 : 1);
