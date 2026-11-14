import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import test from 'node:test';
import { CodexRpc } from '../apps/agent/src/codex-rpc.mjs';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const sent = [];
  child.stdin.on('data', data => sent.push(JSON.parse(data.toString())));
  child.kill = () => {
    if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('close', 0)); }
    return true;
  };
  const rpc = new CodexRpc({ cwd: os.tmpdir(), config: {}, executable: 'test-codex', spawnProcess: () => child });
  t.after(() => rpc.close());
  const emit = message => child.stdout.write(JSON.stringify(message) + '\n');
  const notify = (method, params) => emit({ method, params });
  const acknowledgeTurn = () => {
    const request = sent.find(message => message.method === 'turn/start');
    emit({ id: request.id, result: { turn: { id: 'turn1' } } });
  };
  return { rpc, child, sent, emit, notify, acknowledgeTurn };
}

test('RPC ignores cancelled replies while later requests retain their identity', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const first = f.rpc.call('first', {}, controller.signal);
  const rejected = assert.rejects(first, /отменён/u);
  controller.abort();
  await rejected;
  const second = f.rpc.call('second', {});
  f.emit({ id: f.sent[0].id, result: { stale: true } });
  f.emit({ id: f.sent[1].id, result: { current: true } });
  assert.deepEqual(await second, { current: true });
  assert.equal(f.rpc.pending.size, 0);
});

test('RPC generation uses only its own thread and waits for successful terminal status', async t => {
  const f = fixture(t);
  const generated = f.rpc.generate('thread1', '{}', {}, 'gpt-6-luna');
  f.acknowledgeTurn();
  f.notify('item/completed', { threadId: 'other', item: { type: 'agentMessage', text: 'wrong' } });
  f.notify('turn/completed', { threadId: 'other', turn: { status: 'completed' } });
  f.notify('turn/completed', { threadId: 'thread1', turn: { id: 'older-turn', status: 'completed' } });
  f.notify('item/completed', { threadId: 'thread1', turnId: 'turn1', item: { type: 'agentMessage', text: '{"suggestions":[]}' } });
  f.notify('thread/tokenUsage/updated', { threadId: 'thread1', turnId: 'turn1', tokenUsage: {
    modelContextWindow: 100_000, last: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 4 },
  } });
  f.notify('turn/completed', { threadId: 'thread1', turn: { id: 'turn1', status: 'completed' } });
  assert.deepEqual(await generated, { text: '{"suggestions":[]}', contextWindow: 100_000,
    usage: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 4 } });
  assert.equal(f.rpc.listeners.size, 0);
});

test('a failed turn cannot be accepted merely because it emitted text', async t => {
  const f = fixture(t);
  const rejected = assert.rejects(f.rpc.generate('thread1', '{}', {}, 'gpt-6-luna'), /лимит/u);
  f.acknowledgeTurn();
  f.notify('item/completed', { threadId: 'thread1', turnId: 'turn1', item: { type: 'agentMessage', text: '{"suggestions":[]}' } });
  f.notify('turn/completed', { threadId: 'thread1', turn: { id: 'turn1', status: 'failed', error: { message: 'usage limit exceeded' } } });
  await rejected;
  assert.equal(f.rpc.listeners.size, 0);
});

test('cancellation terminates only the owned worker and rejects its generation', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const rejected = assert.rejects(f.rpc.generate('thread1', '{}', {}, 'gpt-6-luna', controller.signal), /отменён/u);
  f.acknowledgeTurn();
  controller.abort();
  await rejected;
  assert.equal(f.child.killed, true);
  assert.equal(f.rpc.closed, true);
  assert.equal(f.rpc.listeners.size, 0);
  await assert.rejects(f.rpc.call('account/read', {}));
});

test('unexpected interactive tools are rejected and malformed output closes pending calls', async t => {
  const f = fixture(t);
  f.emit({ id: 'approval1', method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(f.sent[0].id, 'approval1');
  assert.equal(f.sent[0].error.code, -32601);
  const rejected = assert.rejects(f.rpc.call('account/read', {}));
  f.child.stdout.write('not JSON\n');
  await rejected;
  assert.equal(f.rpc.closed, true);
  assert.equal(f.rpc.pending.size, 0);
});
