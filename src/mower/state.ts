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

const LEAVING_STATES = new Set([51, 52, 53, 54]);
const MOWING_STATES = new Set([55, 56, 57, 64, 65, 66, 70]);
const RETURNING_STATES = new Set([71, 72, 73, 74, 75]);
// Bare idle (0) is deliberately not here: the mower reports 0 off the dock between a task ending and 143 being set.
const DOCKED_STATES = new Set([61, 62, 63, 68, 76, 77, 104, 105, 106, 151, 152, 153]);
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
  charging: boolean;
  paused: boolean;
  fault: boolean;
  attention: boolean;
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

  const docked = (chargeState !== undefined && CHARGE_STATE_ON_DOCK.has(chargeState)) || DOCKED_STATES.has(state);
  const fault = errorCode !== 0 || FAULT_STATES.has(state);
  return {
    docked,
    leaving: LEAVING_STATES.has(state),
    mowing: MOWING_STATES.has(state),
    returning: !docked && (RETURNING_STATES.has(state) || offDock !== 0),
    charging: chargeState === 1 || CHARGING_STATES.has(state),
    paused: PAUSED_STATES.has(state),
    fault,
    attention: fault || EMERGENCY_STOP_STATES.has(state),
    battery,
    lowBattery: battery !== undefined && battery <= LOW_BATTERY_PERCENT,
    mowState,
    errorCode,
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
