import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackupBundle, restoreBackupBundle } from '../apps/server/src/backup.mjs';
import { decryptBackup, encryptBackup, isEncryptedBackup } from '../packages/shared/src/backup-crypto.mjs';

async function atomicWrite(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

test('server backup round-trips through authenticated encryption', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-hub-backup-'));
  const source = path.join(temporary, 'source');
  const target = path.join(temporary, 'target');
  try {
    await fs.mkdir(path.join(source, 'documents'), { recursive: true });
    await fs.writeFile(path.join(source, 'auth.json'), '{"schema":1}\n');
    await fs.writeFile(path.join(source, 'recovery-pepper.key'), 'test-recovery-pepper\n');
    await fs.writeFile(path.join(source, 'tickets.json'), '{"schema":1,"tickets":[]}\n');
    await fs.writeFile(path.join(source, 'documents', 'one.update'), Buffer.from([0, 1, 2, 255]));
    await fs.writeFile(path.join(source, 'documents', 'one.history.json'), '{"schema":1,"entries":[]}\n');
    await fs.writeFile(path.join(source, 'ignored-secret.txt'), 'not exported');

    const compressed = await createBackupBundle(source, '0.6.5F1');
    const encrypted = await encryptBackup(compressed, 'correct horse battery staple');
    assert.equal(isEncryptedBackup(encrypted), true);
    await assert.rejects(
      decryptBackup(encrypted, 'wrong password here'),
      /incorrect|damaged/i,
    );
    const restored = await restoreBackupBundle(
      await decryptBackup(encrypted, 'correct horse battery staple'),
      target,
      atomicWrite,
    );
    assert.equal(restored.version, '0.6.5F1');
    assert.equal(restored.files, 5);
    assert.equal(await fs.readFile(path.join(target, 'auth.json'), 'utf8'), '{"schema":1}\n');
    assert.equal(await fs.readFile(path.join(target, 'recovery-pepper.key'), 'utf8'), 'test-recovery-pepper\n');
    assert.equal(await fs.readFile(path.join(target, 'tickets.json'), 'utf8'), '{"schema":1,"tickets":[]}\n');
    assert.deepEqual(
      await fs.readFile(path.join(target, 'documents', 'one.update')),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.equal(
      await fs.readFile(path.join(target, 'documents', 'one.history.json'), 'utf8'),
      '{"schema":1,"entries":[]}\n',
    );
    await assert.rejects(fs.access(path.join(target, 'ignored-secret.txt')));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
