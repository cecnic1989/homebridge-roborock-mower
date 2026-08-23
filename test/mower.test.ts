import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { findMowers } from '../src/roborock/mower.js';
import type { HomeData } from '../src/roborock/types.js';

// Captured from a real account (RockMow Z1 / X120H LiDAR) on 2026-08-22; ids sanitised.
const home = JSON.parse(readFileSync(new URL('./fixtures/home-data.json', import.meta.url), 'utf8')) as HomeData;

describe('findMowers', () => {
  test('returns only roborock.mower devices, joined with their product', () => {
    const mowers = findMowers(home);
    assert.equal(mowers.length, 1);
    assert.equal(mowers[0].duid, 'mower-duid');
    assert.equal(mowers[0].model, 'roborock.mower.a282');
    assert.equal(mowers[0].productName, 'RockMow Z1 LiDAR');
    assert.equal(mowers[0].deviceStatus?.['121'], 100);
  });

  test('sees mowers shared into the account (receivedDevices) too', () => {
    const shared: HomeData = { ...home, devices: [], receivedDevices: home.devices };
    assert.equal(findMowers(shared).length, 1);
  });
});
