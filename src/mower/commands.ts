// The four commands the plugin exposes, mapped to the app_button verbs confirmed live on a RockMow a282
// (see CONTRIBUTING.md Design Notes for the remote_pb wire format).
export type MowerAction = 'mow' | 'dock' | 'pause' | 'resume';

export const ACTION_LABELS: Record<MowerAction, string> = { mow: 'Mow', dock: 'Dock', pause: 'Pause', resume: 'Resume' };

const APP_BUTTONS: Record<MowerAction, string> = {
  mow: 'MOW_GLOBAL',
  dock: 'CHARGE',
  pause: 'MOW_PAUSE',
  resume: 'MOW_RESUME',
};

// A RemoteMsg in protobufjs toJSON form: string enum names, id as a decimal-string millisecond timestamp.
export function remotePbParams(action: MowerAction, nowMs: number): Record<string, unknown> {
  return { id: String(nowMs), type: 'APP_BUTTON', app_button: APP_BUTTONS[action] };
}

// Observed live: {"result":["ok"]}; python-roborock also documents a bare "ok".
export function isOk(reply: unknown): boolean {
  return reply === 'ok' || (Array.isArray(reply) && reply.includes('ok'));
}

// Liveness probe (verified live on the a282, 2026-08-26): the mower answers ANY unrecognized method with
// {"result":"unknown_method"} in ~0.1s — a guaranteed, side-effect-free reply over the push subscription.
// The name is deliberately meaningless so no future firmware verb can collide with it.
export const LIVENESS_PROBE = { method: 'liveness_noop', params: [] as unknown[] };
