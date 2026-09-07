import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { AuditLog } from '../apps/server/src/audit-log.mjs';
import { auditDocumentControl } from '../apps/server/src/document-audit.mjs';
import { auditTicketAction } from '../apps/server/src/ticket-audit.mjs';
import { createBackupBundle } from '../apps/server/src/backup.mjs';

test('deletion audit is durable before mutation, keeps canonical actor and survives object deletion/restart/backup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-audit-'));
  try {
    const audit = new AuditLog(directory); await audit.initialise();
    const actor = { id: 'actual-account', displayName: 'Alice' };
    const room = {
      registry: { auditLog: audit }, documentId: 'branch:localisation/russian/test.yml',
      commentThreads: [{ id: 'discussion', authorId: 'owner', messages: [{ body: 'Original comment' }] }],
      suggestions: [], reservations: [], actorFor: () => actor,
    };
    await auditDocumentControl(room, { readyState: 1 }, {
      type: 'comment-delete', id: 'discussion', author: 'Spoofed', token: 'must-not-log',
    }, async () => {
      assert.equal((await audit.list()).records[0].outcome, 'started');
      room.commentThreads = [];
    });
    const store = { get: () => ({ title: 'Deleted ticket', creatorId: 'owner', status: 'draft', files: [] }) };
    await auditTicketAction(audit, store, actor, 'delete', 'ticket-id', async () => ({ ticket: store.get() }));
    const restarted = new AuditLog(directory); await restarted.initialise();
    const records = (await restarted.list({ action: 'comment-', actor: 'actual-account' })).records;
    assert.equal(records.length, 2);
    assert.equal(records[0].outcome, 'completed');
    assert.equal(records[0].actor, 'Alice');
    assert.equal(records[0].details.excerpt, 'Original comment');
    assert.equal(records[0].operationId, records[1].operationId);
    const first = await restarted.list({ limit: 1 });
    const second = await restarted.list({ before: first.nextCursor, limit: 1 });
    assert.ok(second.records[0].sequence < first.records[0].sequence);
    const backup = JSON.parse(gunzipSync(await createBackupBundle(directory, 'test')).toString());
    assert.equal(backup.files.filter((file) => file.path.startsWith('audit/')).length, 4);
    assert.equal(JSON.stringify(backup).includes('must-not-log'), false);
    assert.equal((await restarted.list({ from: '2999-01-01T00:00:00.000Z' })).records.length, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed deletion is distinguishable from success and unavailable audit storage prevents deletion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-audit-fail-'));
  try {
    const audit = new AuditLog(directory); await audit.initialise();
    await assert.rejects(audit.run({ id: 'actor' }, 'ticket-delete', 'ticket', {}, async () => {
      throw Object.assign(new Error('Sensitive error detail'), { code: 'ticket_not_found' });
    }, { destructive: true }));
    const records = (await audit.list()).records;
    assert.equal(records[0].outcome, 'failed');
    assert.equal(records[0].details.errorCode, 'ticket_not_found');
    assert.equal(JSON.stringify(records).includes('Sensitive error detail'), false);
    const blocked = new AuditLog(directory);
    blocked.directory = path.join(directory, 'not-a-directory');
    await fs.writeFile(blocked.directory, 'occupied');
    let deleted = false;
    await assert.rejects(blocked.run({ id: 'actor' }, 'ticket-delete', 'ticket', {}, () => { deleted = true; }, { destructive: true }));
    assert.equal(deleted, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
