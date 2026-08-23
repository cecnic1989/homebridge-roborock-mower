import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { StoredSession } from './types.js';

// Lives outside config.json so the Homebridge UI's schema form can never overwrite it.
export function sessionPath(storagePath: string): string {
  return join(storagePath, 'roborock-mower', 'session.json');
}

function isSession(value: unknown): value is StoredSession {
  const candidate = value as Partial<StoredSession> | null;
  return typeof candidate?.email === 'string'
    && typeof candidate.clientId === 'string'
    && typeof candidate.region?.baseUrl === 'string'
    && typeof candidate.userData?.token === 'string'
    && typeof candidate.userData.rriot === 'object';
}

export async function readSession(storagePath: string): Promise<StoredSession | undefined> {
  let raw: string;
  try {
    raw = await readFile(sessionPath(storagePath), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSession(storagePath: string, session: StoredSession): Promise<void> {
  const path = sessionPath(storagePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function clearSession(storagePath: string): Promise<void> {
  await rm(sessionPath(storagePath), { force: true });
}
