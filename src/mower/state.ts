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

// Where the mower is. One fact, so the flags read off it below cannot contradict each other.
export type Position = 'dock' | 'leaving' | 'out' | 'returning';

export interface DerivedState {
  position: Position;
  reported: boolean; // the mower said where it is, rather than the charge contact having to answer for it
  docked: boolean;
  leaving: boolean;
  mowing: boolean;
  returning: boolean;
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

function isOnContact(dps: Dps): boolean {
  const chargeState = num(dps[DPS.CHARGE_STATE]);
  return chargeState !== undefined && CHARGE_STATE_ON_DOCK.has(chargeState);
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

// What the evidence says, strongest first: a code that places the mower, then the 61-63 waits (reported both
// on the way home and while waiting it out on the dock, so the contact says which), then DPS 143. Undefined
// when only the charge contact is left — the one reading that may be stale.
function positionFromEvidence(code: number, onContact: boolean, offDock: boolean): Position | undefined {
  const fromCode = codePosition(code);
  if (fromCode !== undefined) {
    return fromCode;
  }
  if (DOCK_WAIT_STATES.has(code)) {
    return onContact ? 'dock' : 'returning';
  }
  return offDock ? 'returning' : undefined;
}

export function deriveMowerState(dps: Dps): DerivedState {
  const mowState = num(dps[DPS.MOW_STATE]);
  const chargeState = num(dps[DPS.CHARGE_STATE]);
  const offDock = num(dps[DPS.OFF_DOCK_NO_TASK_STATUS]) ?? 0;
  const battery = num(dps[DPS.BATTERY]);
  const errorCode = num(dps[DPS.ERROR_CODE]) ?? 0;
  const state = mowState ?? -1;

  const onContact = isOnContact(dps);
  const evidence = positionFromEvidence(state, onContact, offDock !== 0);
  // Stands on its own, with no history: the settings page and the cloud comparison both need that.
  const position = evidence ?? (onContact ? 'dock' : 'out');
  const docked = position === 'dock';
  const fault = errorCode !== 0 || FAULT_STATES.has(state);
  return {
    position,
    reported: evidence !== undefined,
    docked,
    leaving: position === 'leaving',
    mowing: MOWING_STATES.has(state),
    returning: position === 'returning',
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

// How long an asserting charge contact is read as the mower re-seating on its way out rather than settling
// back down. The observed re-seats ran 10-13s; past this a mower still on the contacts never left.
export const REJOIN_GRACE_MS = 60_000;

// How long `mowing` is carried over a bare idle: generous next to the half-minute the mower spends between
// zones, short enough that a job whose end push lost its DPS 132 stops reading as mowing.
export const IDLE_HOLD_MAX_MS = 2 * 60_000;

// When the mower entered its current position, and when the current run of bare-idle pushes began.
export interface Since {
  position: number;
  idle: number | undefined;
}

export interface Settled {
  state: DerivedState;
  since: Since;
}

interface Contact {
  on: boolean;
  changed: boolean;
}

// Where the mower goes next. If nothing in this push answers the question, it is where it was.
function nextPosition(state: DerivedState, prev: DerivedState, contact: Contact, enteredFor: number): Position {
  const code = state.mowState ?? -1;
  const fromCode = codePosition(code);
  if (fromCode !== undefined) {
    return fromCode;
  }
  // A changed reading is a current one, and a departure sitting on the contacts longer than re-seating could
  // explain never left. A contact that is neither says nothing: its clearing push may simply be missing.
  const reSeating = prev.position === 'leaving' && enteredFor <= REJOIN_GRACE_MS;
  const current = contact.changed || (prev.position === 'leaving' && !reSeating);
  if (DOCK_WAIT_STATES.has(code)) {
    if (contact.changed) {
      return contact.on ? 'dock' : 'returning';
    }
    return prev.position === 'dock' ? 'dock' : 'returning';
  }
  if (contact.on && current && !reSeating) {
    return 'dock';
  }
  if (!contact.on && contact.changed) {
    return prev.position === 'dock' ? 'out' : prev.position; // nothing breaks a contact without moving
  }
  if (state.reported) {
    return prev.position === 'dock' ? 'returning' : prev.position; // only DPS 143 is left by here
  }
  // A departure is over when the job behind it ends — a cancellation says so outright, even mid-shuffle — or
  // once re-seating can no longer explain the contact. Both are needed: a remote-control undock has no job
  // at any point and would otherwise settle on its first push, losing the window it depends on. The rung
  // above has claimed every seated case by here, so in practice this is a mower that left and went quiet.
  if (prev.position === 'leaving' && ((prev.jobActive && !state.jobActive) || !reSeating)) {
    return contact.on ? 'dock' : 'out';
  }
  return prev.position;
}

// Applies `nextPosition`, then carries `mowing` over a bare idle, which reports no activity at all.
export function settleState(dps: Dps, contactChanged: boolean, prev: DerivedState | undefined, since: Since, now: number): Settled {
  const state = deriveMowerState(dps);
  if (prev === undefined) {
    return { state, since: { position: now, idle: undefined } };
  }
  const contact: Contact = { on: isOnContact(dps), changed: contactChanged };
  const position = nextPosition(state, prev, contact, now - since.position);
  const docked = position === 'dock';
  const settled: DerivedState = {
    ...state,
    position,
    docked,
    leaving: position === 'leaving',
    returning: position === 'returning',
  };
  const idleAt = state.jobActive && state.mowState === 0 && !docked ? since.idle ?? now : undefined;
  const holding = idleAt !== undefined && now - idleAt <= IDLE_HOLD_MAX_MS;
  return {
    state: holding ? { ...settled, mowing: prev.mowing } : settled,
    since: { position: position === prev.position ? since.position : now, idle: idleAt },
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
