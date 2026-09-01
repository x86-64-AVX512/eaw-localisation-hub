import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  generateRecoveryCode,
  normaliseRecoveryCode,
  RecoveryCodeHasher,
} from '../apps/server/src/recovery-code.mjs';
import { AuthStore } from '../apps/server/src/auth.mjs';

async function atomicWrite(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
}

test('recovery codes are strong, checksummed, normalised, and only HMAC-hashed at rest', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-recovery-code-'));
  try {
    const first = generateRecoveryCode();
    const second = generateRecoveryCode();
    assert.match(first, /^EAWH-R1-(?:[A-Z2-7]{4}-){13}[A-Z2-7]{4}$/u);
    assert.notEqual(first, second);
    assert.equal(normaliseRecoveryCode(first.toLowerCase()), first);
    const corruptedLastCharacter = first.endsWith('A') ? 'B' : 'A';
    assert.equal(normaliseRecoveryCode(`${first.slice(0, -1)}${corruptedLastCharacter}`), '');

    const hasher = new RecoveryCodeHasher(directory, atomicWrite);
    await hasher.initialise();
    const hash = hasher.hash(first);
    assert.match(hash, /^[0-9a-f]{64}$/u);
    assert.equal(hasher.matches(first, hash), true);
    assert.equal(hasher.matches(second, hash), false);
    assert.equal((await fs.readFile(path.join(directory, 'recovery-pepper.key'), 'utf8')).includes(first), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an unconfirmed code is invalidated after restart without blocking the account', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-recovery-restart-'));
  const token = 'recovery-restart-session';
  try {
    await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({
      schema: 3,
      users: [{
        id: 'user-1', displayName: 'Translator', roles: ['translator'], passwordVerifier: null,
        color: '#4f8cff', avatarBase64: '', temporaryPassword: false,
        recoveryStatus: 'pending_confirmation', recoveryIssueKind: 'replacement', recoveryCodeHash: 'a'.repeat(64),
      }],
      invites: [],
      sessions: [{
        id: 'session-1', userId: 'user-1',
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }],
    }));
    const auth = new AuthStore(directory, atomicWrite, 'required');
    await auth.initialise();
    const user = await auth.authenticate(token);
    assert.equal(user.recoveryStatus, 'issuance_authorized');
    const persisted = JSON.parse(await fs.readFile(path.join(directory, 'auth.json'), 'utf8'));
    assert.equal(persisted.users[0].recoveryCodeHash, null);
    await auth.flush();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
