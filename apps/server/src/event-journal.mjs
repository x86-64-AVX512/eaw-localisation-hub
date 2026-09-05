import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_EVENTS = 20_000;

export class EventJournal {
  constructor(dataDirectory, atomicWrite) {
    this.target = path.join(dataDirectory, 'events.json');
    this.atomicWrite = atomicWrite;
    this.events = [];
    this.nextSequence = 1;
    this.persistence = Promise.resolve();
  }
  async initialise() {
    try {
      const loaded = JSON.parse(await fs.readFile(this.target, 'utf8'));
      if (loaded.schema !== 1 || !Array.isArray(loaded.events)) throw new Error('Unsupported event journal');
      this.events = loaded.events.slice(-MAX_EVENTS);
      this.nextSequence = Math.max(0, ...this.events.map(({ sequence }) => Number(sequence) || 0)) + 1;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  append(type, actor, recipients, details = {}) {
    const recipientIds = [...new Set((recipients ?? []).map(String).filter(Boolean))]
      .filter((id) => id !== String(actor?.id ?? ''));
    if (!recipientIds.length) return null;
    const previous = this.events.at(-1);
    if (type === 'ticket-edited' && previous?.type === type
      && previous.actorId === String(actor?.id ?? '')
      && previous.details?.ticketId === details.ticketId
      && previous.recipientIds.join(',') === recipientIds.join(',')
      && Date.now() - Date.parse(previous.at) < 10_000) {
      previous.at = new Date().toISOString();
      for (const field of ['lines', 'words', 'characters']) {
        previous.details[field] = Number(previous.details[field] ?? 0) + Number(details[field] ?? 0);
      }
      const snapshot = `${JSON.stringify({ schema: 1, events: this.events })}\n`;
      this.persistence = this.persistence.catch(() => {}).then(() => this.atomicWrite(this.target, snapshot));
      return previous;
    }
    const event = {
      id: crypto.randomUUID(), sequence: this.nextSequence++, type,
      at: new Date().toISOString(), actorId: String(actor?.id ?? ''),
      actor: String(actor?.displayName ?? actor?.actor ?? 'Unknown'), recipientIds, details,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const snapshot = `${JSON.stringify({ schema: 1, events: this.events })}\n`;
    this.persistence = this.persistence.catch(() => {}).then(() => this.atomicWrite(this.target, snapshot));
    return event;
  }
  list(userId, after = 0, limit = 500) {
    const floor = this.events[0]?.sequence ?? this.nextSequence;
    const requested = Math.max(0, Number(after) || 0);
    const scanned = this.events.filter((event) => event.sequence > requested)
      .slice(0, Math.min(1000, Math.max(1, Number(limit) || 500)));
    const events = scanned.filter((event) => event.recipientIds.includes(String(userId)));
    return { events, cursor: scanned.at(-1)?.sequence ?? Math.max(requested, floor - 1), truncated: requested > 0 && requested < floor - 1 };
  }
  async flush() { await this.persistence; }
}
