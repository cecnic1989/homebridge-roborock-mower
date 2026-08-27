import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { deriveMowerState, describeAttention, describeMowState } from '../src/mower/state.js';

// Real sequence captured from a RockMow a282 (edge cut started and returned from the app), see fixtures/dps-sequence.json.
const sequence = JSON.parse(readFileSync(new URL('./fixtures/dps-sequence.json', import.meta.url), 'utf8')) as { dps: Record<string, number> }[];
const seed: Record<number, unknown> = { 121: 100, 122: 0, 123: 0, 127: 2, 132: 0, 139: 100, 143: 0 };

function replay(upTo: number): Record<number, unknown> {
  const dps = { ...seed };
  for (const step of sequence.slice(0, upTo)) {
    for (const [k, v] of Object.entries(step.dps)) {
      dps[Number(k)] = v;
    }
  }
  return dps;
}

const flags = (dps: Record<number, unknown>) => {
  const s = deriveMowerState(dps);
  return { docked: s.docked, leaving: s.leaving, mowing: s.mowing, returning: s.returning, charging: s.charging };
};

describe('deriveMowerState over the captured edge-cut sequence', () => {
  test('idle on dock with charge complete is docked, nothing else', () => {
    assert.deepEqual(flags(replay(0)), { docked: true, leaving: false, mowing: false, returning: false, charging: false });
  });

  test('mow_initializing (51) and undocking (52) are "leaving", no longer docked', () => {
    assert.deepEqual(flags(replay(2)), { docked: false, leaving: true, mowing: false, returning: false, charging: false });
    assert.deepEqual(flags(replay(3)), { docked: false, leaving: true, mowing: false, returning: false, charging: false });
  });

  test('mow_goto (57) is mowing and ends the leaving phase', () => {
    assert.deepEqual(flags(replay(6)), { docked: false, leaving: false, mowing: true, returning: false, charging: false });
  });

  test('idle off the dock right after a task ends is neither docked nor returning', () => {
    assert.deepEqual(flags(replay(8)), { docked: false, leaving: false, mowing: false, returning: false, charging: false });
  });

  test('off_dock_no_task (143) non-zero means returning, because this firmware never reports 71/72', () => {
    assert.deepEqual(flags(replay(9)), { docked: false, leaving: false, mowing: false, returning: true, charging: false });
  });

  test('charge state complete with 143 cleared is docked again', () => {
    assert.deepEqual(flags(replay(11)), { docked: true, leaving: false, mowing: false, returning: false, charging: false });
  });
});

describe('deriveMowerState edge cases', () => {
  test('charging while docked', () => {
    const s = deriveMowerState({ 121: 40, 123: 151, 127: 1, 143: 0 });
    assert.equal(s.docked, true);
    assert.equal(s.charging, true);
  });

  test('explicit mow_to_dock states count as returning', () => {
    assert.equal(deriveMowerState({ 123: 71, 127: 0, 143: 0 }).returning, true);
  });

  // 2026-08-26 incident: a rain return reported 61 straight from mowing, while the mower was still
  // outside a closed garage; treating it as docked closed the door in its face.
  test('a rain/DND/low-battery wait state is docked only with dock contact; off the dock it is returning', () => {
    for (const state of [61, 62, 63]) {
      const stranded = deriveMowerState({ 121: 15, 123: state, 127: 0, 132: 1, 143: 0 });
      assert.equal(stranded.docked, false, `state ${state} without charge contact is not docked`);
      assert.equal(stranded.returning, true, `state ${state} without charge contact is returning`);
      const docked = deriveMowerState({ 121: 15, 123: state, 127: 1, 143: 0 });
      assert.equal(docked.docked, true, `state ${state} with charge contact is docked`);
      assert.equal(docked.returning, false, `state ${state} with charge contact is not returning`);
    }
  });

  test('fault from error code or a fault state, and paused from a pause state', () => {
    assert.equal(deriveMowerState({ 120: 7, 123: 55 }).fault, true);
    assert.equal(deriveMowerState({ 120: 0, 123: 60 }).fault, true);
    assert.equal(deriveMowerState({ 120: 0, 123: 58 }).paused, true);
    assert.equal(deriveMowerState({ 120: 0, 123: 55 }).fault, false);
  });

  test('needs attention on an error code, a fault state, or an emergency stop — not on an app pause', () => {
    assert.equal(deriveMowerState({ 120: 7, 123: 55 }).attention, true);
    assert.equal(deriveMowerState({ 120: 0, 123: 60 }).attention, true);
    assert.equal(deriveMowerState({ 123: 67 }).attention, true);
    assert.equal(deriveMowerState({ 123: 58 }).attention, false);
    assert.equal(deriveMowerState({ 120: 0, 123: 56 }).attention, false);
  });

  test('describeAttention names the error code first, then the state, and is empty when all is well', () => {
    assert.equal(describeAttention(deriveMowerState({ 120: 7, 123: 60 })), 'error 7');
    assert.equal(describeAttention(deriveMowerState({ 123: 67 })), 'mow_emergency_stop');
    assert.equal(describeAttention(deriveMowerState({ 123: 56 })), undefined);
  });

  test('a job counts as active from start push to end push, through pause and rain-dock (DPS 132)', () => {
    assert.equal(deriveMowerState({ 132: 1, 123: 57 }).jobActive, true);
    assert.equal(deriveMowerState({ 132: 1, 123: 58 }).jobActive, true, 'paused mid-job');
    assert.equal(deriveMowerState({ 132: 1, 123: 61, 127: 1 }).jobActive, true, 'rain-docked mid-job');
    assert.equal(deriveMowerState({ 132: 0, 123: 0, 143: 104 }).jobActive, false, 'returning after the job ended');
  });

  test('battery level and low-battery threshold', () => {
    assert.equal(deriveMowerState({ 121: 20 }).lowBattery, true);
    assert.equal(deriveMowerState({ 121: 21 }).lowBattery, false);
    assert.equal(deriveMowerState({}).battery, undefined);
  });

  test('describeMowState names known codes and falls back for unknown ones', () => {
    assert.equal(describeMowState(57), 'mow_goto');
    assert.equal(describeMowState(999), 'unknown(999)');
  });
});
