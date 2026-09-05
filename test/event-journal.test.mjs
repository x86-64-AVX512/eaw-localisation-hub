import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventJournal } from '../apps/server/src/event-journal.mjs';

test('event journal filters recipients, advances cursors, and coalesces typing bursts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-events-'));
  const atomicWrite = async (target, data) => { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data); };
  try {
    const journal = new EventJournal(directory, atomicWrite); await journal.initialise();
    journal.append('comment-reply', { id: 'actor', displayName: 'Actor' }, ['one'], {});
    journal.append('comment-reply', { id: 'actor', displayName: 'Actor' }, ['two'], {});
    journal.append('ticket-edited', { id: 'actor', displayName: 'Actor' }, ['one'], { ticketId: 't', characters: 1, words: 0, lines: 0 });
    journal.append('ticket-edited', { id: 'actor', displayName: 'Actor' }, ['one'], { ticketId: 't', characters: 2, words: 1, lines: 0 });
    const one = journal.list('one', 0, 500);
    assert.equal(one.events.length, 2);
    assert.equal(one.events[1].details.characters, 3);
    assert.equal(one.cursor, 3);
    assert.equal(journal.list('nobody', 0, 500).cursor, 3);
    await journal.flush();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
