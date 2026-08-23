import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { StoredSession } from './types.js';

// Lives outside config.json so the Homebridge UI's schema form can never overwrite it.
export function sessionPath(storagePath: string): string {
  return join(storagePath, 'roborock-mower', 'session.json');
}

export function statusPath(storagePath: string): string {
  return join(storagePath, 'roborock-mower', 'status.json');
}

export interface StatusDevice {
  duid: string;
  name: string;
  model: string;
  productName?: string;
  online: boolean;
  fv?: string;
  mowState?: number;
  mowStateName?: string;
  battery?: number;
}

// Written by the platform after each cloud sync; read by the settings page so it never needs the cloud itself.
export interface PlatformStatus {
  updatedAt: number;
  devices: StatusDevice[];
  lastError?: string;
}

function isSession(value: unknown): value is StoredSession {
  const candidate = value as Partial<StoredSession> | null;
  return typeof candidate?.email === 'string'
    && typeof candidate.clientId === 'string'
    && typeof candidate.region?.baseUrl === 'string'
    && typeof candidate.userData?.token === 'string'
    && typeof candidate.userData.rriot === 'object';
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Write to a sibling temp file and rename so a crash mid-write never leaves a truncated file behind.
async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readSession(storagePath: string): Promise<StoredSession | undefined> {
  const parsed = await readJson(sessionPath(storagePath));
  return isSession(parsed) ? parsed : undefined;
}

export async function writeSession(storagePath: string, session: StoredSession): Promise<void> {
  await writeFileAtomic(sessionPath(storagePath), JSON.stringify(session, null, 2), 0o600);
}

export async function clearSession(storagePath: string): Promise<void> {
  await rm(sessionPath(storagePath), { force: true });
}

export async function readStatus(storagePath: string): Promise<PlatformStatus | undefined> {
  const parsed = await readJson(statusPath(storagePath)) as Partial<PlatformStatus> | undefined;
  return typeof parsed?.updatedAt === 'number' && Array.isArray(parsed.devices) ? parsed as PlatformStatus : undefined;
}

export async function writeStatus(storagePath: string, status: PlatformStatus): Promise<void> {
  await writeFileAtomic(statusPath(storagePath), JSON.stringify(status, null, 2), 0o600);
}
