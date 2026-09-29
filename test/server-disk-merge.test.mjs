import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { WebSocket } from 'ws';
import { DocumentRoom } from '../apps/server/src/document-room.mjs';
import { DocumentHistory } from '../apps/server/src/document-history.mjs';
import { evaluateDiskMerge } from '../apps/server/src/disk-merge.mjs';
import { encodeMergeText } from '../packages/shared/src/merge-wire.mts';

const base = 'l_russian:\n repeated:0 "One"\n repeated:0 "Two"\n';

test('server treats repeated declarations as separate conflict states', () => {
  const shared = base.replace('"One"', '"Shared"');
  const external = base.replace('"Two"', '"Disk"');
  const clean = evaluateDiskMerge({ baseText: base, sharedText: shared,
    personalText: base, externalText: external });
  assert.deepEqual(clean.conflicts, []);
  assert.equal(clean.sharedText, shared.replace('"Two"', '"Disk"'));
  assert.equal(clean.personalText, external);

  const colliding = evaluateDiskMerge({ baseText: base, sharedText: shared,
    personalText: base, externalText: base.replace('"One"', '"Disk"') });
  assert.deepEqual(colliding.conflicts.map(({ key }) => key), ['occ:1:repeated']);
  assert.equal(colliding.sharedText, undefined);
  const resolved = evaluateDiskMerge({ baseText: base, sharedText: shared,
    personalText: base, externalText: base.replace('"One"', '"Disk"'),
    resolutions: { 'occ:1:repeated': 'external' } });
  assert.deepEqual(resolved.conflicts, []);
  assert.equal(resolved.sharedText, base.replace('"One"', '"Disk"'));
  assert.equal(resolved.sharedText.includes('repeated:0 "Two"'), true);
});

test('room only returns a conflict after checking the current shared revision', () => {
  const sharedText = base.replace('"One"', '"Shared"');
  const sent = [];
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0,
    send(value) { sent.push(JSON.parse(value)); } };
  const room = { destroyed: false, document: { getText: () => ({ toString: () => sharedText }) } };
  const request = { type: 'disk-merge-check', requestId: 'request-1',
    baseText: base, personalText: base, externalText: base.replace('"One"', '"Disk"'),
    sharedHash: crypto.createHash('sha256').update(base).digest('hex') };
  DocumentRoom.prototype.applyJson.call(room, socket, request);
  assert.equal(sent[0].stale, true);
  assert.deepEqual(sent[0].conflicts, []);
  request.sharedHash = crypto.createHash('sha256').update(sharedText).digest('hex');
  request.textPatches = Object.fromEntries(['baseText', 'personalText', 'externalText']
    .map((field) => [field, encodeMergeText(sharedText, request[field])]));
  DocumentRoom.prototype.applyJson.call(room, socket, request);
  assert.equal(sent[1].stale, false);
  assert.deepEqual(sent[1].conflicts.map(({ key }) => key), ['occ:1:repeated']);
});

test('server personal Git rebase tracks the changed duplicate occurrence', () => {
  const history = new DocumentHistory('unused');
  history.ensureBaseline(base);
  const mine = base.replace('"Two"', '"Mine"');
  history.replacePersonalProjection({ id: 'translator', displayName: 'Translator' }, mine, base);
  const firstGit = base.replace('"One"', '"New Git"');
  history.updateGitBase(firstGit);
  assert.deepEqual(history.personalGitConflicts('translator'), []);
  assert.equal(history.personalProjection('translator', firstGit),
    firstGit.replace('"Two"', '"Mine"'));

  const secondGit = firstGit.replace('"Two"', '"Other Git"');
  history.updateGitBase(secondGit);
  assert.deepEqual(history.personalGitConflicts('translator').map(({ key }) => key),
    ['occ:2:repeated']);
});
