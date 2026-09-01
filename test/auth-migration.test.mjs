import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthStore } from '../apps/server/src/auth.mjs';

async function atomicWrite(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

test('schema 1 authentication migrates without retaining personal audit metadata', { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-hub-auth-migration-'));
  const token = 'old-session-token';
  await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({
    schema: 1,
    users: [{
      id: 'legacy-admin',
      displayName: 'Legacy Admin',
      role: 'admin',
      enabled: true,
      createdAt: '2025-01-01T00:00:00.000Z',
      lastSeenAt: '2025-01-02T00:00:00.000Z',
      deviceName: 'Personal PC',
    }],
    invites: [],
    sessions: [{
      id: 'legacy-session',
      userId: 'legacy-admin',
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      createdAt: '2025-01-01T00:00:00.000Z',
      deviceName: 'Personal PC',
    }],
  }));

  const auth = new AuthStore(directory, atomicWrite, 'required');
  try {
    const bootstrapCode = await auth.initialise();
    assert.match(bootstrapCode, /^EAW-/);
    const legacyAdmin = await auth.authenticate(token);
    assert.equal(legacyAdmin.displayName, 'Legacy Admin');
    const recovery = await auth.issueRecoveryCode(legacyAdmin);
    await auth.confirmRecoveryCode(legacyAdmin, recovery.code);
    const migratedLogin = await auth.recoverPassword(
      legacyAdmin.displayName, recovery.code, 'Legacy-admin-new-password-932!', 'migration-test',
    );
    assert.equal((await auth.authenticate(migratedLogin.token)).displayName, 'Legacy Admin');
    await assert.rejects(fs.access(path.join(directory, 'bootstrap-invite.txt')), { code: 'ENOENT' });
    const persisted = await fs.readFile(path.join(directory, 'auth.json'), 'utf8');
    assert.equal(JSON.parse(persisted).schema, 5);
    for (const forbidden of [
      'createdAt', 'lastSeenAt', 'deviceName', 'displayNameKey', 'Personal PC',
      bootstrapCode, recovery.code, 'Legacy-admin-new-password-932!',
    ]) {
      assert.equal(persisted.includes(forbidden), false, `migration retained ${forbidden}`);
    }
  } finally {
    await auth.flush();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
