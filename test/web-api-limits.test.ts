import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RoborockApiError, type UserData } from '../src/roborock/types.js';
import { RoborockWebApi } from '../src/roborock/web-api.js';
import { fakeFetch } from './fake-fetch.js';

const region = { baseUrl: 'https://usiot.roborock.com', country: 'US', countryCode: '1' };
const userData: UserData = { token: 'tok', rriot: { u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { a: 'https://api-us.roborock.com' } } };
const homeOk = { success: true, result: { id: 42, products: [], devices: [], receivedDevices: [] } };

describe('RoborockWebApi request discipline', () => {
  test('never overlaps requests: a second call waits for the first to finish', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetch, calls } = fakeFetch({
      '/api/v1/getHomeDetail': async () => {
        await gate;
        return { code: 200, data: { rrHomeId: 42 } };
      },
    });
    const api = new RoborockWebApi({ email: 'e', clientId: 'c', region, fetch });
    const first = api.getHomeId(userData);
    const second = api.getHomeId(userData);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1, 'second request must not be sent while the first is in flight');
    release();
    await Promise.all([first, second]);
    assert.equal(calls.length, 2);
  });

  test('refuses home-data calls beyond the hourly budget without touching the network', async () => {
    let now = 0;
    const { fetch, calls } = fakeFetch({ '/v3/user/homes/42': homeOk });
    const api = new RoborockWebApi({ email: 'e', clientId: 'c', region, fetch, now: () => now });
    for (let i = 0; i < 5; i++) {
      now += 60_000;
      await api.getHomeData(userData, 42);
    }
    now += 60_000;
    await assert.rejects(api.getHomeData(userData, 42), (e: RoborockApiError) => e.code === 429 && /rate/i.test(e.message));
    assert.equal(calls.length, 5);
  });
});
