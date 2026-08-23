import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { API, Logging, PlatformAccessory } from 'homebridge';

import { FakePlatformAccessory, fakeHap } from './fake-hap.js';

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
  accessories: FakePlatformAccessory[];
  storagePath: string;
  emit: (event: string) => void;
}

// Minimal stand-in for the Homebridge API: records registrations and replays events.
export function fakeApi(storagePath = mkdtempSync(join(tmpdir(), 'rr-'))): FakeApi {
  const registered: { name: string; ctor: unknown }[] = [];
  const accessories: FakePlatformAccessory[] = [];
  const listeners = new Map<string, (() => void)[]>();
  const api = {
    hap: { ...fakeHap, uuid: { generate: (seed: string) => `uuid-${seed}` } },
    user: { storagePath: () => storagePath },
    platformAccessory: FakePlatformAccessory,
    registerPlatform: (name: string, ctor: unknown) => registered.push({ name, ctor }),
    registerPlatformAccessories: (_p: string, _n: string, list: PlatformAccessory[]) => accessories.push(...(list as unknown as FakePlatformAccessory[])),
    unregisterPlatformAccessories: (_p: string, _n: string, list: PlatformAccessory[]) => {
      for (const item of list) {
        const index = accessories.indexOf(item as unknown as FakePlatformAccessory);
        if (index >= 0) {
          accessories.splice(index, 1);
        }
      }
    },
    updatePlatformAccessories: () => {},
    on: (event: string, cb: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), cb]),
  } as unknown as API;
  const emit = (event: string) => (listeners.get(event) ?? []).forEach((cb) => cb());
  return { api, registered, accessories, storagePath, emit };
}
