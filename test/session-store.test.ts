import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { clearSession, readSession, sessionPath, writeSession } from '../src/roborock/session-store.js';
import type { StoredSession } from '../src/roborock/types.js';

const session: StoredSession = {
  email: 'user@example.com',
  clientId: 'client-1',
  region: { baseUrl: 'https://usiot.roborock.com', country: 'US', countryCode: '1' },
  userData: { token: 'tok', rriot: { u: 'u', s: 's', h: 'h', k: 'k', r: { a: 'https://api-us.roborock.com' } } },
};

describe('session store', () => {
  test('reads back what was written, and the file is private to the owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rr-'));
    await writeSession(dir, session);
    assert.deepEqual(await readSession(dir), session);
    assert.equal((await stat(sessionPath(dir))).mode & 0o777, 0o600);
  });

  test('treats a missing, corrupt, or incomplete file as signed out instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rr-'));
    assert.equal(await readSession(dir), undefined);
    await writeSession(dir, session);
    await writeFile(sessionPath(dir), '{not json');
    assert.equal(await readSession(dir), undefined);
    await writeFile(sessionPath(dir), JSON.stringify({ email: 'x' }));
    assert.equal(await readSession(dir), undefined);
  });

  test('clearSession removes the file and is a no-op when already signed out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rr-'));
    await writeSession(dir, session);
    await clearSession(dir);
    await assert.rejects(readFile(sessionPath(dir)));
    await clearSession(dir);
  });
});

describe('atomic writes', () => {
  test('leaves no temp file behind and keeps the previous session when the new write cannot complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rr-'));
    await writeSession(dir, session);
    const folder = dirname(sessionPath(dir));
    assert.deepEqual((await readdir(folder)).filter((f) => f.includes('tmp')), []);
    await chmod(folder, 0o500);
    try {
      await assert.rejects(writeSession(dir, { ...session, email: 'new@example.com' }));
      assert.equal((await readSession(dir))?.email, 'user@example.com');
    } finally {
      await chmod(folder, 0o700);
    }
  });
});
