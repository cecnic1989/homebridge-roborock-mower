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
// Leaving, working, mapping, heading home: all of them place the mower away from its dock whatever the charge
// contact says. They have to win, because the contact re-asserts while the mower leaves and the push that
// clears it is the one known to go missing. Every other code — a bare idle, a pause, a fault, the 61-63
// waits, a map being saved — says nothing about position, so there the contact decides and nothing else can.
const OFF_DOCK_STATES = new Set([...LEAVING_STATES, ...MOWING_STATES, ...RETURNING_STATES, ...AWAY_STATES]);
const CHARGING_STATES = new Set([76, 151]);
const PAUSED_STATES = new Set([17, 58, 67, 75, 107]);
const FAULT_STATES = new Set([3, 15, 16, 59, 60, 69, 73, 74, 108, 109, 154]);
// The physical STOP button: the mower will not resume on its own, so it counts as needing attention (an app pause does not).
const EMERGENCY_STOP_STATES = new Set([17, 67, 75, 107]);
const CHARGE_STATE_ON_DOCK = new Set([1, 2, 3]); // charging, completed, waiting
const LOW_BATTERY_PERCENT = 20;

export interface DerivedState {
  docked: boolean;
  leaving: boolean;
  mowing: boolean;
  returning: boolean;
  homeward: boolean;
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

export function deriveMowerState(dps: Dps): DerivedState {
  const mowState = num(dps[DPS.MOW_STATE]);
  const chargeState = num(dps[DPS.CHARGE_STATE]);
  const offDock = num(dps[DPS.OFF_DOCK_NO_TASK_STATUS]) ?? 0;
  const battery = num(dps[DPS.BATTERY]);
  const errorCode = num(dps[DPS.ERROR_CODE]) ?? 0;
  const state = mowState ?? -1;

  // DPS 143 ("off dock, no task") is the most literal report of all, and `returning` below already trusts it
  // — but a code that puts the mower on the dock is newer news than a 143 whose clearing push went missing.
  const away = OFF_DOCK_STATES.has(state) || (offDock !== 0 && !DOCKED_STATES.has(state));
  const docked = !away && ((chargeState !== undefined && CHARGE_STATE_ON_DOCK.has(chargeState)) || DOCKED_STATES.has(state));
  const fault = errorCode !== 0 || FAULT_STATES.has(state);
  const homeward = RETURNING_STATES.has(state) || DOCK_WAIT_STATES.has(state);
  return {
    docked,
    leaving: LEAVING_STATES.has(state),
    mowing: MOWING_STATES.has(state),
    returning: !docked && (homeward || offDock !== 0),
    homeward,
    away,
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
// How long the last known position may be carried over codes that place the mower nowhere. Longer, because
// the only alternative is the charge contact, and a lost clearing push makes it report "home" while the mower
// is still driving there — comfortably past a real return, which took 74s in the 2026-10-03 capture.
export const POSITION_HOLD_MAX_MS = 10 * 60_000;

export interface Settled {
  state: DerivedState;
  silentSince: number | undefined;
}

// Most state codes say where the mower is; some say nothing about it at all — a bare idle, a pause, a fault,
// the 61-63 rain/DND waits. For those the charge contact is the only thing left, and it lies exactly when it
// matters: the push that clears it is the one known to go missing, and until it arrives the contact reports
// the mower home while it is still out. That closed a garage door on a returning mower once (2026-08-26) and
// on a departing one twice (2026-08-29, 2026-10-03). So a code that settles nothing carries what came before
// it, bounded, and anything positive — a code that places the mower, or DPS 143 — takes over at once.
export function settleState(
  dps: Dps, contactBefore: unknown, prev: DerivedState | undefined, silentSince: number | undefined, now: number,
): Settled {
  const state = deriveMowerState(dps);
  const code = state.mowState ?? -1;
  if (prev === undefined || state.away || DOCKED_STATES.has(code)) {
    return { state, silentSince: undefined };
  }
  const since = silentSince ?? now;
  const held = { ...state };
  if (now - since <= POSITION_HOLD_MAX_MS) {
    // The charge contact is physically honest when it is current — nothing breaks one without moving, and
    // nothing asserts one without touching it. The catch is that it may not be current: if a state code has
    // already placed the mower away while the contact still reads on-dock, the push that cleared it never
    // arrived. So an asserting contact means "home" only when this push changed it, or when it was already
    // what we believed, and only when the mower was not in the middle of leaving — on the way out it
    // re-seats on those same contacts. A contact gone clear needs none of that and is simply believed.
    held.docked = state.docked && !prev.leaving && (dps[DPS.CHARGE_STATE] !== contactBefore || prev.docked);
    held.away = !held.docked && prev.away;
    held.homeward = state.homeward || prev.homeward; // 61-63 announce the intent; a bare idle keeps it
    held.returning = !held.docked && held.homeward;
  }
  // A bare idle reports no activity either, and the mower sits at one for up to half a minute between zones.
  if (state.jobActive && code === 0 && now - since <= IDLE_HOLD_MAX_MS) {
    held.leaving = prev.leaving;
    held.mowing = prev.mowing;
    held.returning = prev.returning;
  }
  return { state: held, silentSince: since };
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
