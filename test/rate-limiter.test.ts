import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { HOME_DATA_LIMITS, RateLimiter } from '../src/roborock/rate-limiter.js';

function clock(start = 0) {
  let now = start;
  const advance = (ms: number) => {
    now += ms;
  };
  return { now: () => now, advance };
}

describe('RateLimiter', () => {
  test('enforces the tightest window first and recovers when it slides', () => {
    const c = clock();
    const limiter = new RateLimiter([{ count: 1, perMs: 1000 }, { count: 3, perMs: 60_000 }], c.now);
    assert.equal(limiter.tryAcquire(), true);
    assert.equal(limiter.tryAcquire(), false); // 1/s
    c.advance(1000);
    assert.equal(limiter.tryAcquire(), true);
    c.advance(1000);
    assert.equal(limiter.tryAcquire(), true);
    c.advance(1000);
    assert.equal(limiter.tryAcquire(), false); // 3/min
    c.advance(60_000);
    assert.equal(limiter.tryAcquire(), true);
  });

  test('home-data budget blocks the 6th call in an hour but allows it after an hour', () => {
    const c = clock();
    const limiter = new RateLimiter(HOME_DATA_LIMITS, c.now);
    for (let i = 0; i < 5; i++) {
      c.advance(60_000);
      assert.equal(limiter.tryAcquire(), true, `call ${i + 1}`);
    }
    c.advance(60_000);
    assert.equal(limiter.tryAcquire(), false);
    c.advance(60 * 60_000);
    assert.equal(limiter.tryAcquire(), true);
  });
});
