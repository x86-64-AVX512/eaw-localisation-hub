import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TicketStore } from '../apps/server/src/ticket-store.mjs';
import { TicketService } from '../apps/server/src/ticket-service.mjs';

async function atomicWrite(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data, { mode: 0o600 });
}

class FakeRoom {
  constructor(text) { this.text = text; this.reasons = []; }
  currentText() { return this.text; }
  hasAuthoritativeState() { return true; }
  prepareReplacement(text) { return { value: text, stateBytes: Buffer.byteLength(text) }; }
  replacePrepared(prepared, actor, reason) { this.replaceText(prepared.value, actor, reason); }
  replaceText(text, _actor, reason) { this.text = text; this.reasons.push(reason); }
  async flush() {}
}

test('ticket lifecycle applies verified text, records events, archives, and deletes its rooms', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-ticket-life-'));
  const actor = { id: 'translator-1', displayName: 'Translator' };
  const file = 'localisation/russian/test_l_russian.yml';
  const rooms = new Map();
  const deleted = [];
  const registry = {
    async get(id) { return rooms.get(id); },
    assertBatchStateBudget() {},
    async deleteDocuments(ids) { deleted.push(...ids); for (const id of ids) rooms.delete(id); },
  };
  try {
    const store = new TicketStore(temporary, atomicWrite);
    await store.initialise();
    const ticket = await store.create(actor, {
      title: 'Lifecycle', baseBranch: 'general-dev', baseCommit: 'a'.repeat(40), files: [file],
    });
    const ticketRoom = new FakeRoom('l_russian:\n key:0 "Тикет"\n');
    const mainRoom = new FakeRoom('l_russian:\n key:0 "База"\n');
    rooms.set(`ticket-${ticket.id}:${file}`, ticketRoom);
    rooms.set(`general-dev:${file}`, mainRoom);
    const service = new TicketService(store, registry);
    const snapshot = await service.snapshot(ticket.id);
    assert.equal(snapshot.files[0].ticketInitialised, true);
    assert.equal(snapshot.files[0].mainInitialised, true);
    await assert.rejects(store.update(actor, ticket.id, { status: 'applied' }), /controlled/u);
    const applied = await service.apply(actor, ticket.id, { results: [{
      path: file,
      ticketHash: snapshot.files[0].ticketHash,
      mainHash: snapshot.files[0].mainHash,
      textBase64: Buffer.from('l_russian:\n key:0 "Итог"\n').toString('base64'),
    }] });
    assert.equal(mainRoom.text, 'l_russian:\n key:0 "Итог"\n');
    assert.equal(applied.ticket.status, 'applied');
    assert.equal(applied.ticket.events.at(-1).type, 'applied');
    await store.archive(actor, ticket.id);
    assert.equal(store.list().length, 0);
    assert.equal(store.list({ archived: true }).length, 1);
    await service.delete(actor, ticket.id);
    assert.deepEqual(deleted, [`ticket-${ticket.id}:${file}`]);
    assert.equal(store.list({ archived: true }).length, 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('ticket rebase replaces isolated documents and advances the recorded Git base', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-ticket-rebase-'));
  const actor = { id: 'translator-1', displayName: 'Translator' };
  const file = 'localisation/russian/test_l_russian.yml';
  const rooms = new Map();
  const registry = { async get(id) { return rooms.get(id); }, assertBatchStateBudget() {}, async deleteDocuments() {} };
  try {
    const store = new TicketStore(temporary, atomicWrite);
    const ticket = await store.create(actor, {
      title: 'Rebase', baseBranch: 'old', baseCommit: 'b'.repeat(40), files: [file],
    });
    const room = new FakeRoom('old');
    rooms.set(`ticket-${ticket.id}:${file}`, room);
    rooms.set(`old:${file}`, new FakeRoom('main'));
    const service = new TicketService(store, registry);
    const snapshot = await service.snapshot(ticket.id);
    const result = await service.rebase(actor, ticket.id, {
      baseBranch: 'general-dev', baseCommit: 'c'.repeat(40), results: [{
        path: file, ticketHash: snapshot.files[0].ticketHash,
        mainHash: snapshot.files[0].mainHash, textBase64: Buffer.from('rebased').toString('base64'),
      }],
    });
    assert.equal(room.text, 'rebased');
    assert.equal(result.ticket.baseBranch, 'general-dev');
    assert.equal(result.ticket.baseCommit, 'c'.repeat(40));
    assert.equal(result.ticket.events.at(-1).type, 'rebased');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
