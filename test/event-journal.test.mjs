import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventJournal } from '../apps/server/src/event-journal.mjs';

test('event journal keeps typing events immutable so incremental readers receive every edit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-events-'));
  const atomicWrite = async (target, data) => { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data); };
  try {
    const journal = new EventJournal(directory, atomicWrite); await journal.initialise();
    journal.append('comment-reply', { id: 'actor', displayName: 'Actor' }, ['one'], {});
    journal.append('comment-reply', { id: 'actor', displayName: 'Actor' }, ['two'], {});
    journal.append('ticket-edited', { id: 'actor', displayName: 'Actor' }, ['one'], { ticketId: 't', characters: 1, words: 0, lines: 0 });
    const firstRead = journal.list('one', 0, 500);
    const firstEvent = structuredClone(firstRead.events.at(-1));
    journal.append('ticket-edited', { id: 'actor', displayName: 'Actor' }, ['one'], { ticketId: 't', characters: 2, words: 1, lines: 0 });
    const one = journal.list('one', 0, 500);
    assert.equal(one.events.length, 3);
    assert.deepEqual(one.events[1], firstEvent);
    const incremental = journal.list('one', firstRead.cursor, 500);
    assert.equal(incremental.events.length, 1);
    assert.equal(incremental.events[0].details.characters, 2);
    assert.notEqual(incremental.events[0].id, firstEvent.id);
    assert.equal(one.cursor, 4);
    assert.equal(journal.list('nobody', 0, 500).cursor, 4);
    await journal.flush();
    const restored = new EventJournal(directory, atomicWrite);
    await restored.initialise();
    assert.deepEqual(restored.list('one', firstRead.cursor, 500), incremental);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
