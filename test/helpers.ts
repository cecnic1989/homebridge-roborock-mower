import type { API, Logging } from 'homebridge';

export const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  log: () => {},
  success: () => {},
} as unknown as Logging;

export interface FakeApi {
  api: API;
  registered: { name: string; ctor: unknown }[];
  emit: (event: string) => void;
}

// Minimal stand-in for the Homebridge API: records registrations and replays events.
export function fakeApi(): FakeApi {
  const registered: { name: string; ctor: unknown }[] = [];
  const listeners = new Map<string, (() => void)[]>();
  const api = {
    hap: { Service: {}, Characteristic: {} },
    registerPlatform: (name: string, ctor: unknown) => registered.push({ name, ctor }),
    on: (event: string, cb: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), cb]),
  } as unknown as API;
  const emit = (event: string) => (listeners.get(event) ?? []).forEach((cb) => cb());
  return { api, registered, emit };
}
