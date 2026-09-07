import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const RECORD_NAME = /^\d{16}-[0-9a-f-]{36}\.json$/u;
const bounded = (value, limit = 512) => String(value ?? '').slice(0, limit);

// Independent, immutable records survive deletion of the audited object. There
// are deliberately no editing, deletion, or object-restoration APIs.
export class AuditLog {
  constructor(dataDirectory) {
    this.directory = path.join(dataDirectory, 'audit');
    this.nextSequence = 1;
    this.persistence = Promise.resolve();
  }
  async initialise() {
    await fs.mkdir(this.directory, { recursive: true });
    for (const name of await fs.readdir(this.directory)) {
      if (RECORD_NAME.test(name)) this.nextSequence = Math.max(this.nextSequence, Number(name.slice(0, 16)) + 1);
    }
  }
  append(actor, action, target, details = {}, outcome = 'completed', operationId = crypto.randomUUID()) {
    const record = {
      schema: 1, id: crypto.randomUUID(), sequence: this.nextSequence++, operationId,
      at: new Date().toISOString(), actorId: bounded(actor?.id, 256), actor: bounded(actor?.displayName, 256),
      action: bounded(action, 128), target: bounded(target, 2048), outcome,
      details: JSON.parse(JSON.stringify(details)),
    };
    const data = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(data) > 32 * 1024) return Promise.reject(new Error('Audit record exceeds its limit'));
    const name = `${String(record.sequence).padStart(16, '0')}-${record.id}.json`;
    const write = this.persistence.then(async () => {
      const temporary = path.join(this.directory, `${name}.tmp`);
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, path.join(this.directory, name));
      return record;
    });
    // A failed write blocks later audited operations until the storage is fixed
    // and the server is restarted. Never report success while silently dropping logs.
    this.persistence = write;
    this.persistence.catch(() => {});
    return write;
  }
  async run(actor, action, target, details, operation, { destructive = false } = {}) {
    const operationId = crypto.randomUUID();
    await this.persistence;
    if (destructive) await this.append(actor, action, target, details, 'started', operationId);
    let result;
    try { result = await operation(); }
    catch (error) {
      await this.append(actor, action, target, { ...details, errorCode: bounded(error.code || error.name, 128) }, 'failed', operationId);
      throw error;
    }
    const ticket = result?.ticket;
    await this.append(actor, action, ticket?.id || target,
      ticket ? { ...details, title: bounded(ticket.title), status: bounded(ticket.status, 64) } : details,
      'completed', operationId);
    return result;
  }
  async list({ before = '', actor = '', action = '', from = '', to = '', limit = 100 } = {}) {
    const maximum = Math.min(200, Math.max(1, Number(limit) || 100));
    const names = (await fs.readdir(this.directory)).filter((name) => RECORD_NAME.test(name) && (!before || name < before)).sort().reverse();
    const records = [];
    let cursor = '';
    let scanned = 0;
    for (const name of names) {
      const record = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
      cursor = name; scanned += 1;
      const matches = (!actor || `${record.actorId}\n${record.actor}`.toLocaleLowerCase().includes(String(actor).toLocaleLowerCase()))
        && (!action || record.action.startsWith(String(action)))
        && (!from || record.at >= from) && (!to || record.at <= to);
      if (matches) records.push(record);
      if (records.length >= maximum || scanned >= 5000) break;
    }
    return { records, nextCursor: scanned < names.length ? cursor : '' };
  }
  async flush() { await this.persistence; }
}
