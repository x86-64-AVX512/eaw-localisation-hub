import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startReviewServer } from '../apps/agent/src/review-server.mjs';
import { KeyReplacementWorkflow } from '../apps/agent/src/key-replacement-workflow.mjs';
import { MAX_KEY_REPLACEMENT_REQUEST_BYTES } from '../packages/shared/src/constants.mts';

function sizedBody(payload, bytes) {
  const base = JSON.stringify({...payload, padding: ''});
  const result = JSON.stringify({...payload, padding: 'x'.repeat(bytes - Buffer.byteLength(base))});
  assert.equal(Buffer.byteLength(result), bytes);
  return result;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-key-request-limit-'));
  const repo = path.join(root, 'repo'), state = path.join(root, 'state');
  await fs.mkdir(repo);
  const calls = [];
  const hub = {
    options: {repo},
    currentGitCommit: () => 'a'.repeat(40),
    ticketRequest: async () => {calls.push('ticket'); return {ticket: {id: 'fixture'}};},
    keyReplacementWorkflow: {
      async preview(...args) {calls.push({action: 'preview', args}); return {ok: true};},
      async apply(...args) {calls.push({action: 'apply', args}); return {ok: true};},
    },
  };
  const review = await startReviewServer(hub, {repo, state, workspace: 'fixture'});
  t.after(async () => {await review.close(); await fs.rm(root, {recursive: true, force: true});});
  const {origin, token} = JSON.parse(await fs.readFile(review.discoveryPath, 'utf8'));
  const post = (route, body, authorised = true) => fetch(origin + route, {method: 'POST',
    headers: {'Content-Type': 'application/json', ...(authorised ? {Authorization: `Bearer ${token}`} : {})}, body});
  return {repo, hub, calls, post};
}

for (const action of ['preview', 'apply']) test(`${action} accepts exactly 1 MiB of UTF-8 JSON and rejects one extra byte`, async t => {
  const s = await fixture(t);
  const payload = {input: 'key: "Русский текст"\n', language: 'russian', mode: 'language-filtered', files: [{path: 'localisation/russian/a.yml', hash: 'abc'}]};
  const route = '/api/key-replacements/' + action;
  assert.equal((await s.post(route, '{}', false)).status, 401);
  const accepted = await s.post(route, sizedBody(payload, MAX_KEY_REPLACEMENT_REQUEST_BYTES));
  assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), {ok: true});
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].args[0], payload.input);
  const rejected = await s.post(route, sizedBody(payload, MAX_KEY_REPLACEMENT_REQUEST_BYTES + 1));
  assert.equal(rejected.status, action === 'preview' ? 400 : 409);
  assert.match((await rejected.json()).error, /1 МиБ/u);
  assert.equal(s.calls.length, 1, 'an oversized request must never reach the workflow');
});

test('raising the key request limit leaves ordinary endpoint limits at 64 KiB', async t => {
  const s = await fixture(t);
  const accepted = await s.post('/api/tickets', sizedBody({title: 'Fixture', files: []}, 64 * 1024));
  assert.equal(accepted.status, 200); await accepted.json();
  const rejected = await s.post('/api/tickets', sizedBody({title: 'Fixture', files: []}, 64 * 1024 + 1));
  assert.equal(rejected.status, 400); assert.equal((await rejected.json()).error, 'Request body is too large');
  assert.deepEqual(s.calls, ['ticket']);
});

test('a Russian replacement larger than the former limit previews and writes without truncation', async t => {
  const s = await fixture(t);
  const file = path.join(s.repo, 'localisation/russian/a.yml');
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, '\uFEFFl_russian:\n key:0 "Старое" # сохранить\n');
  s.hub.keyReplacementWorkflow = new KeyReplacementWorkflow(s.hub);
  const value = 'Длинное описание. '.repeat(8000);
  for (const mode of ['classic', 'language-filtered']) {
    const input = `key: "${value}${mode === 'classic' ? 'Первый' : 'Второй'}"`;
    const payload = {input, language: 'russian', mode};
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < MAX_KEY_REPLACEMENT_REQUEST_BYTES);
    const response = await s.post('/api/key-replacements/preview', JSON.stringify(payload));
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.deepEqual(preview.errors, []); assert.equal(preview.changes.length, 1);
    const applied = await s.post('/api/key-replacements/apply', JSON.stringify({...payload, files: preview.files}));
    assert.equal(applied.status, 200); assert.deepEqual(await applied.json(), {changedKeys: 1, changedFiles: 1});
    assert.equal(await fs.readFile(file, 'utf8'), `\uFEFFl_russian:\n key:0 "${preview.entries[0].text}" # сохранить\n`);
  }
  const accepted = await s.hub.keyReplacementWorkflow.preview(Array.from({length: 500}, (_, i) => `key_${i}: "Текст"`).join('\n'));
  assert.deepEqual(accepted.errors, []);
  const rejected = await s.hub.keyReplacementWorkflow.preview(Array.from({length: 501}, (_, i) => `key_${i}: "Текст"`).join('\n'));
  assert.match(rejected.errors[0].message, /500/u);
});
