import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { BranchMergeService } from '../apps/server/src/branch-merge-service.mjs';
import { DocumentRoom } from '../apps/server/src/document-room.mjs';
import { resolveReviewRange } from '../apps/server/src/review-anchors.mjs';
import { GitBranchCache } from '../apps/server/src/git-branch-cache.mjs';
import { RoomRegistry } from '../apps/server/src/room-registry.mjs';
import { TicketStore } from '../apps/server/src/ticket-store.mjs';
import { minimalCommentThread } from '../apps/server/src/room-metadata.mjs';

const file = 'localisation/russian/test_l_russian.yml';
const commit = 'a'.repeat(40);
const targetCommit = 'b'.repeat(40);
const text = 'l_russian:\n key:0 "Текст"\n';

function room(documentId, value = text, comments = []) {
  const document = new Y.Doc();
  document.getText('content').insert(0, value);
  return {
    documentId, document, commentThreads: comments, gitBase: { text: value },
    history: { authorVariants: new Map() },
    currentText: () => document.getText('content').toString(),
    assertMetadataBudget() {}, schedulePersist() {}, broadcastReview() {},
    async flush() {},
  };
}

function comment(document) {
  const position = document.getText('content').toString().indexOf('Текст');
  const content = document.getText('content');
  const encode = (index, associate) => Buffer.from(Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(content, index, associate),
  )).toString('base64');
  return {
    id: 'comment-1', authorId: 'user-1', author: 'Translator', status: 'open',
    messages: [{ id: 'reply-1', body: 'Оставить для general-dev', author: 'Reviewer' }],
    startRelative: encode(position, -1), endRelative: encode(position + 5, 0),
  };
}

function fixture({ targetFiles = [file], sourceText = text, targetText = text } = {}) {
  const source = room(`feature:${file}`, sourceText);
  source.commentThreads.push(comment(source.document));
  const target = room(`general-dev:${file}`, targetText);
  const rooms = new Map([[source.documentId, source], [target.documentId, target]]);
  const steps = [];
  target.flush = async () => { steps.push('target-flush'); };
  const registry = {
    branchHints: new Map([['feature', { commit }]]), mergedBranches: new Map(),
    mergingBranches: new Set(),
    documentIdsForBranch: () => [source.documentId], unresolvedLegacyHashes: () => [],
    get: async (id) => rooms.get(id),
    withRoomsLocked: async (_rooms, operation) => operation(),
    async markBranchMerged(branch, destination, head) {
      steps.push('marked');
      this.mergedBranches.set(branch, { target: destination, commit: head });
    },
    async deleteDocuments(ids) { steps.push('deleted'); assert.deepEqual(ids, [source.documentId]); },
  };
  const ticket = { id: 'ticket-1', baseBranch: 'feature', baseCommit: commit, files: [file] };
  const ticketStore = {
    list: () => [ticket],
    async retargetMergedBranch(branch, destination, head) {
      steps.push('ticket');
      assert.equal(branch, 'feature');
      assert.equal(head, targetCommit);
      ticket.baseBranch = destination;
    },
  };
  const canonical = {
    enabled: true,
    async head(branch) { return { branch, commit: branch === 'feature' ? commit : targetCommit }; },
    async mergedInto() { return true; },
    async listFiles() { return targetFiles; },
  };
  return { service: new BranchMergeService(canonical, registry, ticketStore), source, target,
    ticket, registry, steps };
}

test('verified merge transfers comments before retargeting tickets and deleting source rooms', async () => {
  const { service, target, ticket, steps, registry } = fixture();
  await service.refresh();
  assert.equal(target.commentThreads.length, 1);
  assert.equal(target.commentThreads[0].messages[0].body, 'Оставить для general-dev');
  assert.deepEqual(resolveReviewRange(target.document, target.commentThreads[0]), {
    start: text.indexOf('Текст'), end: text.indexOf('Текст') + 5,
  });
  assert.equal(ticket.baseBranch, 'general-dev');
  assert.equal(ticket.baseCommit, commit);
  assert.deepEqual(steps, ['target-flush', 'ticket', 'marked', 'deleted']);
  assert.equal(registry.mergingBranches.size, 0);
  await service.refresh();
  assert.equal(target.commentThreads.length, 1);
});

test('merge leaves source room and ticket intact when the target file is missing', async () => {
  const { service, target, ticket, steps, registry } = fixture({ targetFiles: [] });
  await service.refresh();
  assert.equal(ticket.baseBranch, 'feature');
  assert.equal(target.commentThreads.length, 0);
  assert.deepEqual(steps, []);
  assert.equal(registry.mergingBranches.size, 0);
});

test('merge does not delete a source room with unmerged shared text', async () => {
  const { service, source, target, ticket, steps, registry } = fixture();
  source.document.getText('content').insert(source.document.getText('content').length, ' extra:0 "Work"\n');
  await service.refresh();
  assert.equal(ticket.baseBranch, 'feature');
  assert.equal(target.commentThreads.length, 0);
  assert.deepEqual(steps, []);
  assert.equal(registry.mergingBranches.size, 0);
});

test('a transferred comment remains visible as orphaned when its key disappeared', async () => {
  const { service, target } = fixture({ targetText: 'l_russian:\n other:0 "Другое"\n' });
  await service.refresh();
  assert.equal(target.commentThreads.length, 1);
  assert.equal(target.commentThreads[0].orphaned, true);
  assert.equal(target.commentThreads[0].messages[0].body, 'Оставить для general-dev');
});

test('retry merges missing replies into an already copied thread without duplicates', async () => {
  const { service, source, target } = fixture();
  target.commentThreads.push({ ...structuredClone(source.commentThreads[0]), messages: [] });
  await service.refresh();
  assert.equal(target.commentThreads.length, 1);
  assert.deepEqual(target.commentThreads[0].messages.map((message) => message.id), ['reply-1']);
});

test('retry carries source-only edits and deletions relative to the saved migration base', async () => {
  const { service, source, target } = fixture();
  const thread = source.commentThreads[0];
  thread.messages = [
    { id: 'root', body: 'Root', author: 'Translator', createdAt: '2026-10-01' },
    { id: 'reply-1', body: 'Old', author: 'Reviewer', createdAt: '2026-10-02' },
    { id: 'reply-2', body: 'Still here', author: 'Reviewer', createdAt: '2026-10-03' },
  ];
  target.flush = async () => { throw new Error('Simulated failed migration after copying'); };
  await service.refresh();
  target.flush = async () => {};
  thread.messages[1] = { ...thread.messages[1], body: 'Edited in branch', revision: 2 };
  thread.messages[2] = { ...thread.messages[2], body: '', deleted: true, revision: 1 };
  thread.messages.push({id:'reply-3',body:'',deleted:true,revision:1,createdAt:'2026-10-04'});
  await service.refresh();
  const messages = target.commentThreads[0].messages;
  assert.deepEqual(messages.map((message) => message.id), ['root', 'reply-1', 'reply-2']);
  assert.equal(messages[0].body, 'Root');
  assert.equal(messages[1].body, 'Edited in branch');
  assert.equal(messages[2].deleted, true);
  assert.deepEqual(target.commentThreads[0].deletedMessageIds,['reply-3']);
});

test('divergent edits after a partial migration keep both versions and do not block the branch', async () => {
  const { service, source, target, ticket, registry } = fixture();
  target.flush = async () => { throw new Error('Simulated failed migration after copying'); };
  await service.refresh();
  target.flush = async () => {};
  Object.assign(source.commentThreads[0].messages[0],{body:'Earlier source edit',revision:2,editedAt:'2026-10-26T10:00:00Z'});
  Object.assign(target.commentThreads[0].messages[0],{body:'Later target edit',revision:1,editedAt:'2026-10-26T11:00:00Z'});
  await service.refresh();
  assert.deepEqual(target.commentThreads[0].messages.map((message) => message.body), ['Later target edit', 'Earlier source edit']);
  assert.equal(target.commentThreads[0].messages[0].revision, 1);
  assert.equal(ticket.baseBranch, 'general-dev');assert.equal(registry.mergedBranches.size, 1);
});

test('a target-only edit made after a partial migration survives retry', async () => {
  const {service,target}=fixture();
  target.flush=async()=>{throw new Error('Simulated failed migration after copying');};
  await service.refresh();target.flush=async()=>{};
  Object.assign(target.commentThreads[0].messages[0],{body:'Target edit',revision:1});
  await service.refresh();
  assert.equal(target.commentThreads[0].messages[0].body,'Target edit');
});

test('a full discussion sends conflicts to an anchored overflow thread and retries survive its deletion', async () => {
  const {service,source,target,ticket}=fixture();
  const original=structuredClone(source.commentThreads[0]);
  original.messages[0].body='Target';
  original.messages.push(...Array.from({length:99},(_,i)=>({id:`target-${i}`,body:'Other',author:'Reviewer'})));
  target.commentThreads=[original];
  target.flush=async()=>{throw new Error('Simulated failed migration after copying');};
  await service.refresh();
  assert.equal(target.commentThreads.length,2);
  assert.equal(target.commentThreads[0].messages.length,100);
  const first=target.commentThreads[1];
  assert.equal(first.messages[0].body,source.commentThreads[0].messages[0].body);
  assert.equal(first.messages[0].mergeConflict,true);
  assert.deepEqual(resolveReviewRange(target.document,first),resolveReviewRange(target.document,original));
  await service.refresh();assert.equal(target.commentThreads.length,2);
  target.commentThreads=[minimalCommentThread(JSON.parse(JSON.stringify(target.commentThreads[0])))];
  await service.refresh();assert.equal(target.commentThreads.length,1);
  Object.assign(source.commentThreads[0].messages[0],{body:'New source version',revision:1});
  await service.refresh();assert.equal(target.commentThreads.length,2);
  assert.notEqual(target.commentThreads[1].id,first.id);
  assert.equal(target.commentThreads[1].messages[0].body,'New source version');
  target.flush=async()=>{};await service.refresh();
  assert.equal(ticket.baseBranch,'general-dev');assert.equal(target.commentThreads.length,2);
});

test('overflow respects room count and metadata budgets without deleting source work or logging success', async context => {
  for(const limit of ['count','metadata']){
    const {service,source,target,ticket,registry}=fixture();
    const original=structuredClone(source.commentThreads[0]);original.messages[0].body='Target';
    original.messages.push(...Array.from({length:99},(_,i)=>({id:`target-${i}`,body:'Other',author:'Reviewer'})));
    target.commentThreads=[original];
    if(limit==='count')target.commentThreads.push(...Array.from({length:499},(_,i)=>({...structuredClone(original),id:`thread-${i}`,messages:[]})));
    else target.assertMetadataBudget=()=>{throw new Error('budget');};
    const before=structuredClone(target.commentThreads);
    const warning=context.mock.method(console,'warn',()=>{});
    await assert.rejects(service.migrate('feature',targetCommit,commit),limit==='count'?/room limit/:/budget/);
    assert.deepEqual(target.commentThreads,before);assert.equal(ticket.baseBranch,'feature');
    assert.equal(registry.mergedBranches.size,0);assert.equal(warning.mock.callCount(),0);warning.mock.restore();
  }
});

test('merge evicts old tombstones instead of rejecting a thread within the live message limit', async () => {
  const { service, source, target } = fixture();
  const reply = (index, deleted = false) => ({ id: `reply-${index}`, body: deleted ? '' : 'Text',
    ...(deleted ? { deleted: true } : {}), author: 'Reviewer', createdAt: `2026-10-01T00:${String(index).padStart(3, '0')}` });
  target.commentThreads.push({ ...structuredClone(source.commentThreads[0]),
    messages: Array.from({ length: 100 }, (_, index) => reply(index + 10, index < 2)) });
  source.commentThreads[0].messages = [reply(1)];
  await service.refresh();
  const messages = target.commentThreads[0].messages;
  assert.equal(messages.length, 100);
  assert.equal(messages[0].id, 'reply-1');
  assert.equal(messages.filter((message) => message.deleted).length, 1);
  assert.deepEqual(target.commentThreads[0].deletedMessageIds,['reply-10']);
});

test('deleted branch is redirected only by an exact merged pull request, not by deletion alone', async () => {
  const calls = [];
  const cache = new GitBranchCache('unused', 'EaW-Team/equestria_dev', {
    fetchImplementation: async (url) => {
      calls.push(url);
      return { ok: true, async json() {
        return url.includes('/pulls?')
          ? [{ merged_at: '2026-09-25T00:00:00Z', base: { ref: 'general-dev' }, head: { sha: commit } }]
          : { status: 'ahead', base_commit: { sha: commit }, head_commit: { sha: targetCommit } };
      } };
    },
  });
  assert.equal(cache.githubRepository, 'EaW-Team/equestria_dev');
  assert.equal(await cache.mergedInto('feature', 'general-dev', commit, targetCommit,
    { sourceStale: true, sourceDeleted: true }), true);
  assert.equal(calls.length, 1);
  const absent = new GitBranchCache('unused', 'EaW-Team/equestria_dev', {
    fetchImplementation: async () => ({ ok: true, async json() { return []; } }),
  });
  assert.equal(await absent.mergedInto('deleted-only', 'general-dev', commit, targetCommit,
    { sourceStale: true, sourceDeleted: true }), false);
});

test('shared ancestry does not retire a live branch without an explicit merge', async () => {
  const cache = new GitBranchCache('unused', 'EaW-Team/equestria_dev', {
    fetchImplementation: async (url) => ({ ok: true, async json() {
      return url.includes('/pulls?') ? [] : {
        status: 'ahead', base_commit: { sha: commit }, head_commit: { sha: targetCommit },
        commits: [{ parents: [{ sha: 'c'.repeat(40) }] }],
      };
    } }),
  });
  assert.equal(await cache.mergedInto('master', 'general-dev', commit, targetCommit), false);
  const explicit = new GitBranchCache('unused', 'EaW-Team/equestria_dev', {
    fetchImplementation: async (url) => ({ ok: true, async json() {
      return url.includes('/pulls?') ? [] : {
        status: 'ahead', base_commit: { sha: commit }, head_commit: { sha: targetCommit },
        commits: [{ parents: [{ sha: 'c'.repeat(40) }, { sha: commit }] }],
      };
    } }),
  });
  assert.equal(await explicit.mergedInto('feature', 'general-dev', commit, targetCommit), true);
});

test('ticket retargeting keeps state and events while leaving missing-file tickets untouched', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-merged-tickets-'));
  const store = new TicketStore(directory, (name, data) => fs.writeFile(name, data));
  const actor = { id: 'user-1', displayName: 'Translator' };
  try {
    const movable = await store.create(actor, {
      title: 'First', baseBranch: 'feature', baseCommit: commit, files: [file],
    });
    const missing = await store.create(actor, {
      title: 'Second', baseBranch: 'feature', baseCommit: commit,
      files: ['localisation/russian/removed_l_russian.yml'],
    });
    await store.update(actor, movable.id, { status: 'review' });
    const result = await store.retargetMergedBranch('feature', 'general-dev', targetCommit, [file]);
    assert.deepEqual(result.moved, [movable.id]);
    assert.deepEqual(result.unresolved.map((item) => item.id), [missing.id]);
    assert.equal(store.get(movable.id).status, 'review');
    assert.equal(store.get(movable.id).baseBranch, 'general-dev');
    assert.equal(store.get(movable.id).baseCommit, commit);
    assert.equal(store.get(movable.id).events.at(-1).type, 'branch_merged');
    assert.equal(store.get(movable.id).events.at(-1).details.mergedIntoCommit, targetCommit);
    assert.equal(store.get(missing.id).baseBranch, 'feature');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('legacy branch rooms are found by hash and unresolved rooms block deletion', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-merged-rooms-'));
  const documents = path.join(directory, 'documents');
  const missingFile = 'localisation/russian/removed_l_russian.yml';
  const registry = new RoomRegistry(directory, {}, async () => null, async () => {});
  try {
    await fs.mkdir(documents);
    for (const relativePath of [file, missingFile]) {
      const hash = crypto.createHash('sha256').update(`feature:${relativePath}`).digest('hex');
      await fs.writeFile(path.join(documents, `${hash}.json`), JSON.stringify({
        schema: 3, gitBase: { branch: 'feature', commit, checkedAt: 1 },
      }));
    }
    await registry.initialise();
    assert.deepEqual(registry.documentIdsForBranch('feature', [file]), [`feature:${file}`]);
    assert.equal(registry.unresolvedLegacyHashes('feature', [file]).length, 1);
  } finally {
    await registry.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('new room index survives restart without exposing the document id in room metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-room-index-'));
  const documents = path.join(directory, 'documents');
  const documentId = `feature:${file}`;
  const hash = crypto.createHash('sha256').update(documentId).digest('hex');
  const atomicWrite = async (name, data) => { await fs.writeFile(name, data); };
  let registry;
  let restored;
  try {
    await fs.mkdir(documents);
    registry = new RoomRegistry(directory, {}, async () => null, atomicWrite);
    await registry.initialise();
    const room = {
      documentId, hash, stateBudgetBytes: 0, destroyed: false,
      updatePath: path.join(documents, `${hash}.update`),
      metadataPath: path.join(documents, `${hash}.json`),
      historyPath: path.join(documents, `${hash}.history.json`),
    };
    await registry.persistRoom(room, Buffer.from('update'), '{"schema":3}', '{}');
    await registry.close();
    registry = null;
    assert.equal((await fs.readFile(room.metadataPath, 'utf8')).includes(documentId), false);
    restored = new RoomRegistry(directory, {}, async () => null, atomicWrite);
    await restored.initialise();
    assert.deepEqual(restored.documentIdsForBranch('feature'), [documentId]);
  } finally {
    await registry?.close();
    await restored?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a persisted room remains readable but not writable when its branch disappears without a Git cache', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-deleted-branch-room-'));
  const documentId = `feature:${file}`;
  const hash = crypto.createHash('sha256').update(documentId).digest('hex');
  const documents = path.join(directory, 'documents');
  const stored = new Y.Doc();
  stored.getText('content').insert(0, text);
  let loaded;
  try {
    await fs.mkdir(documents);
    await fs.writeFile(path.join(documents, `${hash}.update`), Buffer.from(Y.encodeStateAsUpdate(stored)));
    await fs.writeFile(path.join(documents, `${hash}.json`), JSON.stringify({
      schema: 3, gitBase: { branch: 'feature', commit, blob: 'old-blob', text },
    }));
    loaded = await DocumentRoom.load(directory, documentId, { required: false }, {
      persistedBytesFor: () => 0,
    }, { enabled: true, snapshot: async () => { throw new Error('Remote branch not found'); } });
    assert.equal(loaded.currentText(), text);
    assert.equal(loaded.gitBase.stale, true);
    assert.equal(loaded.gitStatusFor({ localBlob: 'old-blob' }).status, 'git-unavailable');
    assert.equal(loaded.clientWritable({ gitWritable: false }), false);
  } finally {
    loaded?.destroy();
    stored.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
