// DPS ids and state codes from python-roborock (RoborockMowerDataProtocol / RoborockMowerStateCode),
// cross-checked against a RockMow a282 capture (test/fixtures/dps-sequence.json).
export const DPS = {
  ERROR_CODE: 120,
  BATTERY: 121,
  MOW_TYPE: 122,
  MOW_STATE: 123,
  CHARGE_STATE: 127,
  DOCK_STATE: 128,
  CHARGE_TYPE: 129,
  MOW_START_TYPE: 132,
  MOW_PROGRESS: 139,
  OFF_DOCK_NO_TASK_STATUS: 143,
} as const;

export const MOW_STATE_NAMES: Record<number, string> = {
  0: 'idle',
  1: 'map_initializing', 2: 'map_undocking', 3: 'map_undock_fault', 4: 'map_locating', 5: 'map_prepare_boundary',
  6: 'map_prepare_island', 7: 'map_prepare_path', 8: 'map_boundary', 9: 'map_island', 10: 'map_path',
  11: 'map_boundary_auto', 12: 'map_erasing', 13: 'map_save', 14: 'map_wait', 15: 'map_recoverable_fault',
  16: 'map_fault', 17: 'map_emergency_stop', 18: 'map_waiting_fault',
  51: 'mow_initializing', 52: 'mow_undocking', 53: 'mow_locating', 54: 'mow_adjust_cutter', 55: 'mow_zig_zag',
  56: 'mow_edge', 57: 'mow_goto', 58: 'mow_suspend', 59: 'mow_recoverable_fault', 60: 'mow_fault',
  61: 'mow_docked_rainfall', 62: 'mow_docked_do_not_disturb', 63: 'mow_docked_low_battery', 64: 'mow_wait',
  65: 'mow_prepare_remote', 66: 'mow_remote', 67: 'mow_emergency_stop', 68: 'mow_docked_manual', 69: 'mow_dock_fault',
  70: 'mow_remote_undocking', 71: 'mow_to_dock_initializing', 72: 'mow_to_dock_locating', 73: 'mow_to_dock_recoverable_fault',
  74: 'mow_to_dock_fault', 75: 'mow_to_dock_emergency_stop', 76: 'mow_to_dock_charging', 77: 'mow_to_dock_charge_completed',
  101: 'free', 102: 'free_initializing', 103: 'free_locating', 104: 'free_docked_manual', 105: 'free_docked_mow_end',
  106: 'free_docked_plan_end', 107: 'free_emergency_stop', 108: 'free_recoverable_fault', 109: 'free_fault',
  151: 'charge_charging', 152: 'charge_completed', 153: 'charge_waiting', 154: 'charge_fault',
};

// 70 is mow_remote_undocking: leaving the dock under remote control is still leaving the dock.
const LEAVING_STATES = new Set([51, 52, 53, 54, 70]);
const MOWING_STATES = new Set([55, 56, 57, 64, 65, 66]);
const RETURNING_STATES = new Set([71, 72, 73, 74, 75]);
// Bare idle (0) is deliberately not here: the mower reports 0 off the dock between a task ending and 143 being set.
const DOCKED_STATES = new Set([68, 76, 77, 104, 105, 106, 151, 152, 153]);
// Rain/DND/low-battery waits (61-63): reported as soon as the mower decides to head home, before it is
// physically back on the dock — only charge contact proves it arrived. Off the dock they mean "returning".
const DOCK_WAIT_STATES = new Set([61, 62, 63]);
// Building a map or roaming free puts the mower on the lawn just as definitely as mowing does, though it is
// not mowing. Deliberately excluded: map_erasing/map_save/map_wait and every fault, which can all be reported
// on the dock.
const AWAY_STATES = new Set([1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 101, 102, 103]);
const CHARGING_STATES = new Set([76, 151]);
const PAUSED_STATES = new Set([17, 58, 67, 75, 107]);
const FAULT_STATES = new Set([3, 15, 16, 59, 60, 69, 73, 74, 108, 109, 154]);
// The physical STOP button: the mower will not resume on its own, so it counts as needing attention (an app pause does not).
const EMERGENCY_STOP_STATES = new Set([17, 67, 75, 107]);
const CHARGE_STATE_ON_DOCK = new Set([1, 2, 3]); // charging, completed, waiting
const LOW_BATTERY_PERCENT = 20;

// Where the mower is, as one fact rather than a handful of booleans that have to be kept consistent.
export type Position = 'dock' | 'leaving' | 'out' | 'returning';

export interface DerivedState {
  position: Position;
  reported: boolean; // whether the mower said where it is, or the charge contact had to answer for it
  docked: boolean;
  leaving: boolean;
  mowing: boolean;
  returning: boolean;
  away: boolean; // the mower's own report that it is out of the dock, which outranks the charge contact
  charging: boolean;
  paused: boolean;
  fault: boolean;
  attention: boolean;
  jobActive: boolean;
  battery?: number;
  lowBattery: boolean;
  mowState?: number;
  errorCode: number;
}

export type Dps = Record<number, unknown>;

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return value === undefined || value === null || Number.isNaN(n) ? undefined : n;
}

// Where a state code places the mower. Codes missing from here say nothing about position — a bare idle, a
// pause, a fault, a map being saved — and leave the question to DPS 143 and the charge contact.
function codePosition(code: number): Position | undefined {
  if (LEAVING_STATES.has(code)) {
    return 'leaving';
  }
  if (MOWING_STATES.has(code) || AWAY_STATES.has(code)) {
    return 'out';
  }
  if (RETURNING_STATES.has(code)) {
    return 'returning';
  }
  return DOCKED_STATES.has(code) ? 'dock' : undefined;
}

export function deriveMowerState(dps: Dps): DerivedState {
  const mowState = num(dps[DPS.MOW_STATE]);
  const chargeState = num(dps[DPS.CHARGE_STATE]);
  const offDock = num(dps[DPS.OFF_DOCK_NO_TASK_STATUS]) ?? 0;
  const battery = num(dps[DPS.BATTERY]);
  const errorCode = num(dps[DPS.ERROR_CODE]) ?? 0;
  const state = mowState ?? -1;

  const onContact = chargeState !== undefined && CHARGE_STATE_ON_DOCK.has(chargeState);
  const waiting = DOCK_WAIT_STATES.has(state); // 61-63: interrupted, and belongs at the dock — but is it there yet?
  const fromCode = codePosition(state);
  // Best guess without any history: what the code says, then DPS 143, then the contact. `settleState` is
  // where memory gets a say; this has to stand on its own for the settings page and the cloud comparison.
  const position = fromCode
    ?? (waiting ? (onContact ? 'dock' : 'returning') : undefined)
    ?? (offDock !== 0 ? 'returning' : undefined)
    ?? (onContact ? 'dock' : 'out');
  const docked = position === 'dock';
  const reported = fromCode !== undefined || waiting || offDock !== 0;
  const fault = errorCode !== 0 || FAULT_STATES.has(state);
  return {
    position,
    reported,
    docked,
    leaving: position === 'leaving',
    mowing: MOWING_STATES.has(state),
    returning: position === 'returning',
    // The door-opening trigger, so it takes the mower's own word for it: a bare contact flicker is only a
    // flicker, and the debounce is there to absorb it.
    away: reported && !docked,
    charging: chargeState === 1 || CHARGING_STATES.has(state),
    paused: PAUSED_STATES.has(state),
    fault,
    attention: fault || EMERGENCY_STOP_STATES.has(state),
    // DPS 132 is set on the start push and cleared on the end push — through pauses and mid-job rain docks.
    jobActive: (num(dps[DPS.MOW_START_TYPE]) ?? 0) !== 0,
    battery,
    lowBattery: battery !== undefined && battery <= LOW_BATTERY_PERCENT,
    mowState,
    errorCode,
  };
}

// How long the activity flags may be carried over a bare idle: generous next to the half-minute the mower
// spends between zones, short enough that a job whose end push lost its DPS 132 stops reading as mowing.
export const IDLE_HOLD_MAX_MS = 2 * 60_000;

// When the mower entered its current position, and when the current run of bare-idle pushes began.
export interface Since {
  position: number | undefined;
  idle: number | undefined;
}

export interface Settled {
  state: DerivedState;
  since: Since;
}

// How long an asserting charge contact is read as the mower re-seating on its way out rather than settling
// back down. The observed re-seats ran 10-13s; past this a mower still on the contacts never left.
export const REJOIN_GRACE_MS = 60_000;

interface Contact {
  on: boolean;
  changed: boolean; // a contact that just changed is current, and current is what makes it worth believing
}

// Where the mower goes next. Evidence first, in order of how directly it answers the question; if nothing in
// this push answers it, the mower is still where it was. A position is never left on a timer alone, with one
// exception, noted below, where the mower's last known position was the dock anyway.
function nextPosition(state: DerivedState, prev: DerivedState, contact: Contact, enteredFor: number): Position {
  const code = state.mowState ?? -1;
  const fromCode = codePosition(code);
  if (fromCode !== undefined) {
    return fromCode;
  }
  // 61-63 are reported from the moment the mower decides to head home and for as long as it then waits on
  // the dock, so they say nothing about position by themselves. A current contact settles which it is; a
  // stale one would claim a mower still on the lawn was home, so without one the mower stays where it was.
  if (DOCK_WAIT_STATES.has(code)) {
    if (contact.changed) {
      return contact.on ? 'dock' : 'returning';
    }
    return prev.position === 'dock' ? 'dock' : 'returning';
  }
  if (contact.changed) {
    if (!contact.on) {
      return prev.position === 'dock' ? 'out' : prev.position; // nothing breaks a contact without moving
    }
    return prev.position === 'leaving' && enteredFor <= REJOIN_GRACE_MS ? 'leaving' : 'dock';
  }
  // A departure that is still on the contacts this long after starting never left — and unlike a mower that
  // is out, its last known position *is* the dock, so believing the contact here cannot shut it out.
  if (prev.position === 'leaving' && contact.on && enteredFor > REJOIN_GRACE_MS) {
    return 'dock';
  }
  // Nothing current. DPS 143 still reports it away, and a job ending under a stalled departure settles it.
  if (state.reported) {
    return prev.position === 'dock' ? 'returning' : prev.position;
  }
  if (prev.position === 'leaving' && !state.jobActive) {
    return contact.on ? 'dock' : 'out';
  }
  return prev.position;
}

// Memory, in the one place that needs it. Position is a state machine over the pushes, so a charge contact
// that lies about having the mower home cannot move it — which closed a garage door on a returning mower
// once (2026-08-26) and on a departing one twice (2026-08-29, 2026-10-03). The activity flags need a little
// of the same: DPS 123 = 0 reports nothing at all, yet the mower sits there for up to half a minute between
// zones, and taken at face value that dropped Mowing and brought it straight back.
export function settleState(
  dps: Dps, contactBefore: unknown, prev: DerivedState | undefined, since: Since, now: number,
): Settled {
  const state = deriveMowerState(dps);
  if (prev === undefined) {
    return { state, since: { position: now, idle: undefined } };
  }
  const charge = dps[DPS.CHARGE_STATE];
  const contact: Contact = {
    on: CHARGE_STATE_ON_DOCK.has(num(charge) ?? -1),
    changed: charge !== contactBefore,
  };
  const position = nextPosition(state, prev, contact, now - (since.position ?? now));
  const docked = position === 'dock';
  const settled: DerivedState = {
    ...state,
    position,
    docked,
    leaving: position === 'leaving',
    returning: position === 'returning',
    away: (state.reported || prev.away) && !docked,
  };
  const positionAt = position === prev.position ? since.position ?? now : now;
  const idling = state.jobActive && state.mowState === 0 && !docked;
  if (!idling) {
    return { state: settled, since: { position: positionAt, idle: undefined } };
  }
  const idleAt = since.idle ?? now;
  return {
    state: now - idleAt > IDLE_HOLD_MAX_MS ? settled : { ...settled, mowing: prev.mowing },
    since: { position: positionAt, idle: idleAt },
  };
}

export function describeMowState(code: number | undefined): string {
  if (code === undefined) {
    return 'unknown';
  }
  return MOW_STATE_NAMES[code] ?? `unknown(${code})`;
}

// Why the mower needs attention, for logs and the settings page. Roborock publishes no mower error-code table, so codes stay numeric.
export function describeAttention(state: DerivedState): string | undefined {
  if (!state.attention) {
    return undefined;
  }
  return state.errorCode !== 0 ? `error ${state.errorCode}` : describeMowState(state.mowState);
}
