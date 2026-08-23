import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RoborockApiError, type UserData } from '../src/roborock/types.js';
import { RoborockWebApi } from '../src/roborock/web-api.js';
import { fakeFetch } from './fake-fetch.js';

// Happy-path envelope shapes ({code:200,data} for *iot hosts, {success,result} for the Hawk host)
// were confirmed against the real API on 2026-08-22. Error codes come from python-roborock/ioBroker.
const email = 'user@example.com';
const usRegion = { baseUrl: 'https://usiot.roborock.com', country: 'US', countryCode: '1' };
const userData: UserData = {
  token: 'tok',
  rriot: { u: 'u1', s: 's1', h: 'h1', k: 'k1', r: { a: 'https://api-us.roborock.com' } },
};

function api(fetch: typeof globalThis.fetch, region?: typeof usRegion) {
  return new RoborockWebApi({ email, clientId: 'client-1', fetch, region });
}

describe('resolveRegion', () => {
  test('skips hosts that do not know the account and keeps the country values from the one that does', async () => {
    let attempts = 0;
    const { fetch, calls } = fakeFetch({
      '/api/v1/getUrlByEmail': () => {
        attempts++;
        return attempts === 1
          ? { code: 3039, msg: 'not here' }
          : { code: 200, data: { url: 'https://euiot.roborock.com', country: 'DE', countrycode: '49' } };
      },
    });
    const region = await api(fetch).resolveRegion();
    assert.deepEqual(region, { baseUrl: 'https://euiot.roborock.com', country: 'DE', countryCode: '49' });
    assert.deepEqual(calls.map((c) => c.url.host), ['usiot.roborock.com', 'euiot.roborock.com']);
  });

  test('rejects a malformed email without trying other hosts', async () => {
    const { fetch, calls } = fakeFetch({ '/api/v1/getUrlByEmail': { code: 2003 } });
    await assert.rejects(api(fetch).resolveRegion(), (e: RoborockApiError) => e.code === 2003);
    assert.equal(calls.length, 1);
  });
});

describe('requestEmailCode', () => {
  test('moves to the next host when Roborock answers 3030 (wrong region)', async () => {
    const { fetch, calls } = fakeFetch({
      '/api/v1/getUrlByEmail': (req) => ({ code: 200, data: { url: `https://${req.url.host}`, country: 'US', countrycode: '1' } }),
      '/api/v4/email/code/send': (req) => (req.url.host === 'usiot.roborock.com' ? { code: 3030 } : { code: 200 }),
    });
    const region = await api(fetch).requestEmailCode();
    assert.equal(region.baseUrl, 'https://euiot.roborock.com');
    const sends = calls.filter((c) => c.url.pathname === '/api/v4/email/code/send').map((c) => c.url.host);
    assert.deepEqual(sends, ['usiot.roborock.com', 'euiot.roborock.com']);
  });

  test('gives up on 3030 after every region host instead of recursing forever', async () => {
    const { fetch, calls } = fakeFetch({
      // The server's canonical URL need not match a BASE_URLS entry byte for byte.
      '/api/v1/getUrlByEmail': (req) => ({ code: 200, data: { url: `https://${req.url.host}/`, country: 'US', countrycode: '1' } }),
      '/api/v4/email/code/send': { code: 3030 },
    });
    await assert.rejects(api(fetch).requestEmailCode(), (e: RoborockApiError) => e.code === 3030);
    assert.equal(calls.filter((c) => c.url.pathname === '/api/v4/email/code/send').length <= 4, true);
  });

  test('maps unknown-account and rate-limit codes to readable errors', async () => {
    for (const [code, pattern] of [[2008, /no roborock account/i], [9002, /too many/i]] as const) {
      const { fetch } = fakeFetch({ '/api/v4/email/code/send': { code } });
      await assert.rejects(api(fetch, usRegion).requestEmailCode(), (e: RoborockApiError) => e.code === code && pattern.test(e.message));
    }
  });
});

describe('loginWithCode', () => {
  test('sends the key from key/sign as x-mercy-k and its nonce as x-mercy-ks', async () => {
    const { fetch, calls } = fakeFetch({
      '/api/v3/key/sign': { code: 200, data: { k: 'signed-key' } },
      '/api/v4/auth/email/login/code': { code: 200, data: userData },
    });
    const result = await api(fetch, usRegion).loginWithCode('123456');
    assert.equal(result.token, 'tok');
    const sign = calls.find((c) => c.url.pathname === '/api/v3/key/sign')!;
    const login = calls.find((c) => c.url.pathname === '/api/v4/auth/email/login/code')!;
    assert.equal(login.headers['x-mercy-k'], 'signed-key');
    assert.equal(login.headers['x-mercy-ks'], sign.url.searchParams.get('s'));
  });

  test('maps an invalid code and a pending user agreement to readable errors', async () => {
    for (const [code, pattern] of [[2018, /invalid or expired/i], [3009, /user agreement/i]] as const) {
      const { fetch } = fakeFetch({
        '/api/v3/key/sign': { code: 200, data: { k: 'k' } },
        '/api/v4/auth/email/login/code': { code },
      });
      await assert.rejects(api(fetch, usRegion).loginWithCode('000000'), (e: RoborockApiError) => e.code === code && pattern.test(e.message));
    }
  });
});

describe('getHomeId', () => {
  test('reports an expired session on 2010', async () => {
    const { fetch } = fakeFetch({ '/api/v1/getHomeDetail': { code: 2010 } });
    await assert.rejects(api(fetch, usRegion).getHomeId(userData), (e: RoborockApiError) => e.code === 2010 && /session/i.test(e.message));
  });
});

describe('getHomeData', () => {
  test('fetches the v3 home from the rriot API host with a Hawk signature', async () => {
    const { fetch, calls } = fakeFetch({
      '/v3/user/homes/42': { success: true, result: { id: 42, products: [], devices: [], receivedDevices: [] } },
    });
    const home = await api(fetch, usRegion).getHomeData(userData, 42);
    assert.equal(home.id, 42);
    assert.equal(calls[0].url.host, 'api-us.roborock.com');
    assert.match(calls[0].headers.authorization, /^Hawk id="u1",/);
  });

  test('rejects a success envelope without a home instead of returning null', async () => {
    const { fetch } = fakeFetch({ '/v3/user/homes/42': { success: true, result: null } });
    await assert.rejects(api(fetch, usRegion).getHomeData(userData, 42), (e: RoborockApiError) => /home/i.test(e.message));
  });

  test('blames the host clock when a signed request is rejected and the server time is far off', async () => {
    const skewed = new Date(Date.now() + 5 * 60 * 1000).toUTCString();
    const { fetch } = fakeFetch({
      '/v3/user/homes/42': new Response('{"code":401}', { status: 401, headers: { date: skewed } }),
    });
    await assert.rejects(api(fetch, usRegion).getHomeData(userData, 42), /clock/i);
  });
});
