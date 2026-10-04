import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  type DerivedState, IDLE_HOLD_MAX_MS, REJOIN_GRACE_MS, type Since, deriveMowerState, describeAttention, describeMowState,
  settleState,
} from '../src/mower/state.js';

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

// Replays a push sequence as the platform does: merge the delta, then settle it against the last state.
function replayPushes(steps: { at: number; dps: Record<number, unknown> }[]): DerivedState[] {
  const dps: Record<number, unknown> = {};
  let prev: DerivedState | undefined;
  let since: Since = { position: 0, idle: undefined };
  return steps.map((step) => {
    const contactBefore = dps[127];
    Object.assign(dps, step.dps);
    const settled = settleState(dps, dps[127] !== contactBefore, prev, since, step.at);
    since = settled.since;
    prev = settled.state;
    return settled.state;
  });
}

// What the mower reports while charging part-way through a job: idle, on the contacts, DPS 132 still set.
const chargingMidJob = { 121: 85, 123: 0, 127: 1, 132: 1, 143: 0 };
const mowingMidJob = { 121: 46, 123: 57, 127: 0, 132: 1, 143: 0 };

describe('leaving the dock', () => {
  // 2026-10-03: resuming from a mid-job charge the mower re-seated on the charge contacts for 10s during the
  // undock shuffle. DPS 127 went back to "charging", docked closed again, and the garage door shut on it.
  test('a charge contact re-touch during the undock shuffle never re-docks the mower', () => {
    const docked = replayPushes([
      { at: 0, dps: chargingMidJob },
      { at: 1_000, dps: { 123: 51 } }, // mow_initializing, contacts still live
      { at: 3_000, dps: { 123: 52 } }, // undocking
      { at: 4_000, dps: { 123: 0, 127: 1 } }, // re-seats: "charging" again for 10s
      { at: 14_000, dps: { 123: 51 } },
      { at: 21_000, dps: { 123: 57, 127: 0 } }, // mow_goto, clear of the contacts
    ]).map((state) => state.docked);
    assert.deepEqual(docked, [true, false, false, false, false, false]);
  });

  test('driving home docks it again on arrival', () => {
    const states = replayPushes([
      { at: 0, dps: chargingMidJob },
      { at: 1_000, dps: { 123: 51 } },
      { at: 10_000, dps: { 123: 57, 127: 0 } },
      { at: 20_000, dps: { 123: 61 } }, // rain: heads home with the job still open
      { at: 30_000, dps: { 123: 76, 127: 1 } }, // on the dock, charging
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, false, false, false, true]);
    assert.equal(states[3].returning, true, 'a rain return is not mistaken for a departure');
  });

  // A departure is read as a departure while the re-seat could still explain the contact. Past that window a
  // mower still sitting on the contacts never left, and unlike a mower out on the lawn it cannot be shut out
  // by saying so — the dock is where it was all along.
  test('a start that stalls is back on the dock once the re-seat window has passed', () => {
    const states = replayPushes([
      { at: 0, dps: chargingMidJob },
      { at: 1_000, dps: { 123: 51 } },
      { at: 5_000, dps: { 123: 0 } }, // gives up, DPS 132 still set, contact unchanged
      { at: REJOIN_GRACE_MS, dps: { 121: 86 } }, // still inside the window: still a departure
      { at: REJOIN_GRACE_MS + 6_000, dps: { 121: 85 } },
      { at: REJOIN_GRACE_MS + 7_000, dps: { 123: 51 } }, // and now it tries again
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, false, false, false, true, false]);
    // Deliberate: while the mower is still reporting a mow-start code it is still leaving, so a retry inside
    // one stalled start gives Leaving no fresh edge. Automate the departure from Docked, which does edge.
    assert.deepEqual(states.map((state) => state.leaving), [false, true, true, true, false, true]);
  });

  // Cancelled while still seated, inside the re-seat window: the job is over and the mower is on the
  // contacts, so it is home. Deliberate — the window exists for a mower on its way out, not a cancelled one.
  test('a departure cancelled while still on the contacts is docked', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 100, 123: 153, 127: 2, 132: 1, 143: 0 } },
      { at: 1_000, dps: { 123: 52, 127: 0 } }, // undocking
      { at: 4_000, dps: { 123: 0, 122: 0, 132: 0, 127: 2 } }, // cancelled, and back on the contacts
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, false, true]);
  });

  // No job flag at any point, so nothing ever says the departure ended: without the re-seat window as a
  // backstop this one sat in `leaving` for good, showing the Mow switch on for a mower doing nothing.
  test('a remote undock that gets out and goes quiet stops reporting itself as leaving', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 100, 123: 152, 127: 2, 132: 0, 143: 0 } },
      { at: 1_000, dps: { 123: 70, 127: 0 } }, // driven out under remote control
      { at: 5_000, dps: { 123: 0 } }, // and then it stops saying anything at all
      { at: REJOIN_GRACE_MS + 9_000, dps: { 121: 99 } },
    ]);
    assert.deepEqual(states.map((state) => state.position), ['dock', 'leaving', 'leaving', 'out']);
    assert.deepEqual(states.map((state) => state.docked), [true, false, false, false], 'and never shuts the door on it');
  });

  // The mirror of the remote-undock latch: here the job flag never clears, because the end push never comes.
  // Past the re-seat window the mower is off the contacts and demonstrably not departing any more.
  test('a departure that faults out on the lawn stops reporting itself as leaving', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 100, 123: 153, 127: 2, 132: 1, 143: 0 } },
      { at: 1_000, dps: { 123: 51, 127: 0 } }, // leaves the contacts
      { at: 5_000, dps: { 123: 60 } }, // mow_fault, out on the lawn, and DPS 132 is never cleared
      { at: REJOIN_GRACE_MS + 9_000, dps: { 121: 99 } },
    ]);
    assert.deepEqual(states.map((state) => state.position), ['dock', 'leaving', 'leaving', 'out']);
    assert.deepEqual(states.map((state) => state.docked), [true, false, false, false]);
  });

  test('a departure cancelled out on the lawn is out, not still leaving', () => {
    const states = replayPushes([
      { at: 0, dps: chargingMidJob },
      { at: 1_000, dps: { 123: 52, 127: 0 } }, // undocking, off the contacts
      { at: 5_000, dps: { 123: 0, 122: 0, 132: 0 } }, // cancelled from the app before any mow code arrived
    ]);
    assert.deepEqual(states.map((state) => state.position), ['dock', 'leaving', 'out']);
    assert.equal(states[2].leaving, false, 'or the Mow switch stays on for good');
  });

  // DPS 127 is the one push known to go missing. If the "contacts clear" push is lost, the contact still
  // reads charging while the mower cuts grass — and a close-on-Docked automation would lock it out.
  test('a mower that reports mowing, or heading home, is not docked whatever the contact says', () => {
    for (const state of [51, 55, 56, 57, 64, 65, 66, 70, 71, 75, 2, 8, 102]) {
      const docked = deriveMowerState({ 121: 70, 123: state, 127: 1, 132: 1, 143: 0 }).docked;
      assert.equal(docked, false, `state ${state} with a stale charge contact is still not docked`);
    }
  });

  test('a bare idle mid-mow keeps the mower out, even if the charge contact has gone stale', () => {
    const states = replayPushes([
      { at: 0, dps: mowingMidJob },
      { at: 10_000, dps: { 123: 55, 127: 1 } }, // the contacts-clear push was lost: 127 is stale
      { at: 20_000, dps: { 123: 0 } }, // and now a bare idle, which 127 alone would read as docked
    ]);
    assert.deepEqual(states.map((state) => state.docked), [false, false, false]);
    assert.deepEqual(states.map((state) => state.mowing), [true, true, true]);
  });

  test('a bare idle keeps a return consistent, so nothing downstream reads it as a departure', () => {
    const states = replayPushes([
      { at: 0, dps: mowingMidJob },
      { at: 10_000, dps: { 123: 71 } }, // heading home
      { at: 20_000, dps: { 123: 0 } },
    ]);
    assert.deepEqual(states.map((state) => state.returning), [false, true, true]);
    assert.deepEqual(states.map((state) => state.position), ['out', 'returning', 'returning']);
  });

  // 2026-08-26: a rain return reported 61 while the mower was still outside a closed garage. The contact is
  // the only thing that tells that from a mower waiting out rain on its dock — so if the push that cleared
  // the contact was lost, the contact alone would send the door down on it all over again.
  // Positive evidence always beats what is held: if the undock state code is the push that goes missing,
  // DPS 143 alone has to open the door, and the mower is moving while it waits.
  test('a bare idle that reports itself off the dock is off the dock, held position or not', () => {
    const states = replayPushes([
      { at: 0, dps: chargingMidJob },
      { at: 1_000, dps: { 123: 0, 127: 0, 143: 104 } }, // left, with no 51/52 push to announce it
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, false]);
    assert.equal(states[1].position, 'out', 'it has just left, so it is out — not on its way back');
  });

  // A pause or a fault says the mower stopped, not where it stopped. With the contacts-clear push lost, the
  // contact would answer "on the dock" and shut the door on a mower stopped out on the lawn.
  test('a pause or fault out on the lawn does not hand the dock decision back to a stale contact', () => {
    for (const code of [58, 59, 60, 67, 107]) {
      const states = replayPushes([
        { at: 0, dps: { 121: 40, 123: 55, 127: 1, 132: 1, 143: 0 } }, // mowing; the contacts-clear push was lost
        { at: 10_000, dps: { 123: code } },
      ]);
      assert.equal(states[1].docked, false, `state ${code} does not dock a mower that was out`);
    }
  });

  // Nothing breaks a charge contact without moving, so a lone contact push is the whole story when the push
  // carrying 51/52 is the one that went missing — and that is the push the garage door waits on.
  test('a charge contact going clear is believed on its own, with no state code to vouch for it', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 100, 123: 0, 127: 2, 132: 0, 143: 0 } }, // parked on the dock
      { at: 1_000, dps: { 132: 1 } }, // a mow starts; the 51/52 push never arrives
      { at: 2_000, dps: { 127: 0 } }, // it rolls off the contacts, and that is all we are told
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, true, false]);
  });

  // The flicker has to recover on the very next push. Held "nowhere" with no way back, a one-push drop at
  // 3am would open the garage and leave it open until the hold expired.
  test('a charge contact that drops for one push is back where it was on the next', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 100, 123: 0, 127: 2, 132: 0, 143: 0 } }, // parked on the dock
      { at: 1_000, dps: { 127: 0 } }, // one push with the contact dropped out
      { at: 2_000, dps: { 127: 2 } },
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, false, true]);
  });

  // The mirror case: the contact asserting is the doubtful half, but once the mower is out and not mid-exit
  // it is the only arrival signal this firmware may give.
  test('a charge contact asserting after a mow is an arrival, not a re-seat', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 40, 123: 55, 127: 0, 132: 1, 143: 0 } }, // mowing
      { at: 10_000, dps: { 123: 0 } }, // between zones; no return code and no 143 ever arrives
      { at: 20_000, dps: { 127: 2 } }, // and now it is charging, so it is home
    ]);
    assert.deepEqual(states.map((state) => state.docked), [false, false, true]);
    assert.equal(states[2].position, 'dock', 'and it stops claiming to be out');
  });

  test('a rain return with a stale charge contact is still out on the lawn, and says so', () => {
    for (const wait of [61, 62, 63]) {
      const states = replayPushes([
        { at: 0, dps: { 121: 40, 123: 55, 127: 1, 132: 1, 143: 0 } }, // mowing; the contacts-clear push was lost
        { at: 10_000, dps: { 123: wait } }, // rain: heads home, with the contact still reading charging
      ]);
      assert.equal(states[1].docked, false, `state ${wait} does not dock a mower that was out`);
      assert.equal(states[1].returning, true, `state ${wait} reports the return instead`);
    }
  });

  test('once a code puts it back on the dock, the dock is where it is', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 40, 123: 55, 127: 1, 132: 1, 143: 0 } },
      { at: 10_000, dps: { 123: 61 } }, // heading home
      { at: 20_000, dps: { 123: 76 } }, // arrived: charging on the dock
      { at: 30_000, dps: { 123: 61 } }, // and now genuinely waiting out the rain, docked
    ]);
    assert.deepEqual(states.map((state) => state.docked), [false, false, true, true]);
  });

  test('a code that puts it on the dock outranks a DPS 143 that was never cleared', () => {
    assert.equal(deriveMowerState({ 121: 100, 123: 76, 127: 1, 143: 104 }).docked, true);
    assert.equal(deriveMowerState({ 121: 100, 123: 152, 127: 2, 143: 104 }).docked, true);
  });

  // The capture shows the end push ({122,123,132}) landing before DPS 143, so a job can end out on the lawn
  // with the job flag already cleared. If the contacts-clear push was lost too, 143 is the only truth left.
  test('off-dock-no-task (143) outranks a stale charge contact, with no job left to vouch for it', () => {
    const state = deriveMowerState({ 121: 55, 122: 0, 123: 0, 127: 2, 132: 0, 143: 104 });
    assert.equal(state.docked, false, 'DPS 143 says it is off the dock, whatever the contact reads');
    assert.equal(state.returning, true, 'and nothing suppresses the sensor that says so');
  });

  test('a map rebuild leaves the dock like a mow does, though it is not mowing', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 100, 123: 0, 127: 2, 132: 0, 143: 0 } }, // parked, no job
      { at: 1_000, dps: { 123: 2 } }, // map_undocking, contacts still live
      { at: 10_000, dps: { 123: 8, 127: 1 } }, // mapping a boundary, and the contacts-clear push was lost
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, false, false]);
    assert.deepEqual(states.map((state) => state.mowing), [false, false, false]);
  });

  // An abort says the mower stopped, not where it stopped, so its position is whatever it last was — the
  // door stays open rather than closing on a mower that faulted halfway out. The contact takes over once
  // the position hold runs out.
  test('an abort does not move the mower, so it does not move the door either', () => {
    const states = replayPushes([
      { at: 0, dps: chargingMidJob },
      { at: 1_000, dps: { 123: 51 } },
      { at: 5_000, dps: { 123: 69 } }, // mow_dock_fault
      { at: REJOIN_GRACE_MS + 6_000, dps: { 121: 84 } }, // still on the contacts well past the re-seat window
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, false, false, true]);
    assert.equal(states[2].attention, true, 'and it says it needs attention on the push that reports it');
  });

  test('a remote-control undock counts as leaving, not as mowing', () => {
    const states = replayPushes([
      { at: 0, dps: chargingMidJob },
      { at: 1_000, dps: { 123: 70 } }, // mow_remote_undocking, contacts still live
      { at: 4_000, dps: { 123: 0, 127: 1 } }, // re-seats: "charging" again
      { at: 14_000, dps: { 123: 66, 127: 0 } }, // out, under remote control
    ]);
    assert.deepEqual(states.map((state) => state.docked), [true, false, false, false]);
    assert.deepEqual(states.map((state) => state.leaving), [false, true, true, false]);
  });
});

// The captured sequence is the real device start-to-finish, and it ends with the mower reaching its dock on
// {127: 2, 143: 0} with 123 still idle — no docked state code anywhere. Derivation alone gets this right; it
// is `settleState`, the layer the platform actually pushes through, that has to agree.
// A position only ever left on evidence needs enough evidence to leave on, or it latches. A charge contact
// that has just changed is current, so it is consulted ahead of everything but a state code.
describe('a changed charge contact is current evidence', () => {
  test('a mower waiting out rain docks when the contact says it got there, with 123 still on 61', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 20, 123: 55, 127: 0, 132: 1, 143: 0 } }, // mowing
      { at: 10_000, dps: { 123: 61 } }, // rain: heading home
      { at: 74_000, dps: { 127: 1 } }, // arrives and starts charging; the code never moves off 61
    ]);
    assert.deepEqual(states.map((state) => state.position), ['out', 'returning', 'dock']);
    assert.equal(states[2].charging, true, 'charging and docked, not charging and returning');
  });

  test('an arrival split across two pushes still arrives', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 40, 123: 0, 127: 0, 132: 0, 143: 104 } }, // off dock, task over, heading back
      { at: 10_000, dps: { 127: 2 } }, // the capture's arrival, with 143 lagging a push behind
      { at: 11_000, dps: { 143: 0 } },
    ]);
    assert.deepEqual(states.map((state) => state.position), ['returning', 'dock', 'dock']);
  });

  // The re-seat window has to hold whether or not the mower has a job flag: a remote-control undock has
  // none, and a mow can lose the push that sets DPS 132. Without that, the exit shuffle re-docks the mower
  // and the garage door comes down on it — the 2026-08-29 and 2026-10-03 failure.
  for (const [label, job] of [['with a job running', 1], ['with no job flag at all', 0]] as const) {
    test(`a stalled departure docks on the contact past the re-seat window, not before, ${label}`, () => {
      const start: { at: number; dps: Record<number, unknown> }[] = [
        { at: 0, dps: { 121: 100, 123: 153, 127: 2, 132: job, 143: 0 } },
        { at: 1_000, dps: { 123: 52, 127: 0 } }, // undocking, contacts clear
        { at: 2_000, dps: { 123: 0 } }, // and it stops saying anything about where it is
      ];
      const inside = replayPushes([...start, { at: 11_000, dps: { 127: 1 } }]); // re-seats: the exit shuffle
      assert.deepEqual(inside.map((state) => state.docked), [true, false, false, false]);
      const outside = replayPushes([...start, { at: REJOIN_GRACE_MS + 2_000, dps: { 127: 1 } }]);
      assert.deepEqual(outside.map((state) => state.docked), [true, false, false, true]);
    });
  }
});

describe('settleState over the captured sequence', () => {
  test('the mower is docked at the start and docked again at the end', () => {
    const states = replayPushes([
      { at: 0, dps: seed },
      ...sequence.map((step, index) => ({
        at: 1_000 + index * 1_000,
        dps: Object.fromEntries(Object.entries(step.dps).map(([k, v]) => [Number(k), v])),
      })),
    ]);
    assert.equal(states[0].docked, true, 'idle on the dock, charge complete');
    assert.equal(states.at(-1)?.docked, true, 'and home again — or the garage door never closes');
    assert.equal(states.at(-1)?.returning, false);
  });

  test('the departure in the middle is never read as a return to the dock', () => {
    const states = replayPushes([
      { at: 0, dps: seed },
      ...sequence.slice(0, 4).map((step, index) => ({
        at: 1_000 + index * 1_000,
        dps: Object.fromEntries(Object.entries(step.dps).map(([k, v]) => [Number(k), v])),
      })),
    ]);
    assert.deepEqual(states.slice(1).map((state) => state.docked), [true, false, false, false]);
  });
});

// Position is one fact now, so the flags read off it cannot contradict each other and nothing here tests
// that. These pin the behaviour that used to go wrong when they could.
describe('position as the single source of truth', () => {
  // The position used to revert to the charge contact when a hold expired, so a mower paused on the lawn
  // with a stale contact had its garage closed on it ten minutes in.
  test('a mower paused out on the lawn stays out, however long nothing new arrives', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 40, 123: 55, 127: 1, 132: 1, 143: 0 } }, // mowing; the contacts-clear push was lost
      { at: 60_000, dps: { 123: 58 } }, // paused from the app, out on the lawn
      { at: 660_000, dps: { 121: 38 } }, // eleven minutes later, just a battery push
      { at: 3_660_000, dps: { 121: 36 } }, // an hour later, still only battery pushes
    ]);
    assert.deepEqual(states.map((state) => state.docked), [false, false, false, false]);
  });

  // `homeward` latched with no reset, so the next departure reported itself as a return.
  test('a departure after an arrival is a departure, not another return', () => {
    const states = replayPushes([
      { at: 0, dps: { 121: 40, 123: 71, 127: 0, 132: 1, 143: 104 } }, // heading home
      { at: 74_000, dps: { 123: 0, 127: 2, 143: 0 } }, // arrives, the capture's signature
      { at: 200_000, dps: { 132: 0 } }, // job ends, idling on the dock
      { at: 300_000, dps: { 127: 0 } }, // and off it goes again
    ]);
    assert.deepEqual(states.map((state) => state.position), ['returning', 'dock', 'dock', 'out']);
    assert.deepEqual(states.map((state) => state.returning), [true, false, false, false]);
  });
});

describe('a bare idle mid-job', () => {
  test('keeps the previous activity: the mower sits at 0 for up to half a minute between zones', () => {
    const states = replayPushes([
      { at: 0, dps: mowingMidJob },
      { at: 10_000, dps: { 123: 0 } }, // 33s of idle, as observed on 2026-10-03
      { at: 43_000, dps: { 123: 55 } },
    ]);
    assert.deepEqual(states.map((state) => state.mowing), [true, true, true]);
  });

  test('does not outlive the job: idle on the end push is no longer mowing', () => {
    const states = replayPushes([
      { at: 0, dps: mowingMidJob },
      { at: 10_000, dps: { 122: 0, 123: 0, 132: 0 } }, // task ended
    ]);
    assert.deepEqual(states.map((state) => state.mowing), [true, false]);
  });

  test('does not outlive its bound: a job-end push that loses DPS 132 still stops reading as mowing', () => {
    const states = replayPushes([
      { at: 0, dps: mowingMidJob },
      { at: 10_000, dps: { 123: 0 } }, // the 132 -> 0 half of the end push never arrived
      { at: IDLE_HOLD_MAX_MS + 11_000, dps: { 121: 45 } },
    ]);
    assert.deepEqual(states.map((state) => state.mowing), [true, true, false]);
  });
});
