import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pluginMessageTypes,
  validatePluginMessage,
  validateServerMessage,
} from '../packages/shared/src/protocol-schema.mjs';

test('plugin protocol schema accepts typed edit messages', () => {
  const message = {
    type: 'edit',
    path: 'C:\\repo\\localisation\\russian\\file.yml',
    positionByte: 12,
    deleteBytes: 4,
    insertBase64: '0J/RgNC40LLQtdGC',
  };
  assert.equal(validatePluginMessage(message), message);
});

test('Review reservation commands accept their bounded optional comment', () => {
  assert.doesNotThrow(() => validatePluginMessage({
    type: 'reservationCreate', path: 'C:\\repo\\localisation\\russian\\file.yml',
    startByte: 1, endByte: 20, assigneeId: 'user-1', assignee: 'Translator',
    assigneeColor: '#66aaff', comment: 'Проверить терминологию',
  }));
});

test('plugin protocol schema rejects field confusion and unknown commands', () => {
  assert.throws(() => validatePluginMessage({
    type: 'edit', path: 'x.yml', positionByte: '12', deleteBytes: 0, insertBase64: '',
  }), /positionByte/);
  assert.throws(() => validatePluginMessage({ type: 'edit', path: 'x.yml' }), /positionByte/);
  assert.throws(() => validatePluginMessage({ type: 'runCommand', command: 'whoami' }), /Unknown plugin message type/);
  assert.throws(() => validatePluginMessage({ type: 'close', path: 'x.yml', surprise: true }), /Unknown protocol field/);
});

test('every dispatched plugin command has an explicit schema', () => {
  assert.deepEqual(pluginMessageTypes, [
    'hello', 'open', 'activate', 'deactivate', 'close', 'edit', 'snapshot', 'cursor', 'undo', 'redo',
    'reviewOpen', 'reservationCreate', 'reservationDeleteAt', 'reservationDelete', 'commentCreate', 'commentReply',
    'commentStatus', 'commentDelete', 'suggestionCreate', 'suggestionUpdate', 'suggestionReply', 'suggestionAccept',
    'suggestionRevert', 'suggestionReject', 'suggestionDelete', 'avatarSet', 'avatarDelete',
    'recoveryIssue', 'recoveryConfirm', 'recoveryDiscard', 'externalConflictResolve',
    'historyRequest', 'historyRestore', 'personalFileMaterialize', 'documentVariantRequest',
  ]);
});

test('server protocol schema validates nested collaborative state', () => {
  const message = {
    type: 'synced', protocol: 14, version: '0.8.6F3', documentId: 'general-dev:localisation/russian/x.yml',
    canSeed: false, reservations: [], commentThreads: [], suggestions: [], presences: [],
    git: {
      status: 'branch-outdated', branch: 'general-dev', localHead: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40), localBlob: 'c'.repeat(40), remoteBlob: 'c'.repeat(40),
      changedFiles: ['localisation/russian/x.yml'], checkedAt: Date.now(), reason: 'branch-head-outdated',
    },
    identity: { id: 'u1', displayName: 'User', color: '#abcdef', roles: ['translator'] },
    directory: [],
  };
  assert.equal(validateServerMessage(message), message);
  assert.throws(() => validateServerMessage({ ...message, reservations: [{}] }), /Reservation id/);
  assert.equal(validateServerMessage({
    type: 'git-status', status: 'conflict', branch: 'general-dev', remoteHead: 'b'.repeat(40),
    remoteBlob: 'c'.repeat(40), changedFiles: ['localisation/russian/x.yml'], reason: 'file-blob-differs',
    conflicts: [{ key: 'x', label: 'x', detail: 'Один ключ изменён с обеих сторон.',
      baseLine: 'x:0 "старое"', collaborativeLine: 'x:0 "совместное"', externalLine: 'x:0 "Git"' }],
  }).status, 'conflict');
  assert.throws(() => validateServerMessage({ type: 'shell', command: 'whoami' }), /Unknown server message/);
});
