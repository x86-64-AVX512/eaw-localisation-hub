import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AuthError } from './auth.mjs';
import { TRACKED_PATH_PATTERN } from '../../../packages/shared/src/constants.mjs';

const STATUSES = new Set(['draft', 'in_progress', 'review', 'needs_changes', 'ready', 'git_conflict', 'applied', 'closed']);
const USER_STATUSES = new Set(['draft', 'in_progress', 'review', 'needs_changes', 'ready', 'closed']);
const TICKET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BRANCH_PATTERN = /^(?![./])(?!.*(?:\.\.|@\{|[~^:?*[\\]))(?!.*[./]$)[^\u0000-\u0020\u007f]{1,200}$/u;
const MAX_EVENTS = 500;

function boundedText(value, name, maximum, required = false) {
  const result = String(value ?? '').trim();
  if ((required && !result) || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new AuthError(`${name} is invalid`, 400, 'invalid_ticket');
  }
  return result;
}

export function trackedTicketFile(value) {
  const result = String(value ?? '').replaceAll('\\', '/');
  if (!TRACKED_PATH_PATTERN.test(result) || result.includes('//')
      || result.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new AuthError('Ticket file is outside supported localisation paths', 400, 'invalid_ticket_file');
  }
  return result;
}

function ticketFiles(value) {
  const files = [...new Set((Array.isArray(value) ? value : []).map(trackedTicketFile))];
  if (files.length < 1 || files.length > 50) {
    throw new AuthError('Ticket must contain 1 to 50 files', 400, 'invalid_ticket');
  }
  return files;
}

function validCommit(value) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(result)) throw new AuthError('Base commit is invalid', 400, 'invalid_ticket');
  return result;
}

function validBranch(value) {
  const result = boundedText(value, 'Base branch', 200, true);
  if (!BRANCH_PATTERN.test(result)) throw new AuthError('Base branch is invalid', 400, 'invalid_ticket');
  return result;
}

function publicTicket(ticket) {
  return {
    ...ticket,
    files: [...ticket.files],
    participantIds: [...ticket.participantIds],
    events: ticket.events.map((event) => ({ ...event, details: { ...event.details } })),
  };
}

function actorSummary(actor) {
  return { actorId: String(actor?.id ?? ''), actor: String(actor?.displayName ?? 'Local user') };
}

export class TicketStore {
  constructor(dataDirectory, atomicWrite, commitVerifier = null) {
    this.target = path.join(dataDirectory, 'tickets.json');
    this.atomicWrite = atomicWrite;
    this.tickets = [];
    this.persistence = Promise.resolve();
    this.commitVerifier = commitVerifier;
  }

  async initialise() {
    try {
      const loaded = JSON.parse(await fs.readFile(this.target, 'utf8'));
      if (![1, 2].includes(loaded.schema) || !Array.isArray(loaded.tickets)) throw new Error('Unsupported ticket store');
      this.tickets = loaded.tickets.filter((ticket) => TICKET_ID_PATTERN.test(ticket.id)).map((ticket) => ({
        ...ticket,
        files: ticketFiles(ticket.files),
        participantIds: Array.isArray(ticket.participantIds) ? ticket.participantIds.map(String) : [],
        archivedAt: String(ticket.archivedAt ?? ''),
        events: Array.isArray(ticket.events) ? ticket.events.slice(-MAX_EVENTS) : [],
      }));
      if (loaded.schema === 1) await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  persist() {
    const data = `${JSON.stringify({ schema: 2, tickets: this.tickets }, null, 2)}\n`;
    this.persistence = this.persistence.catch(() => {}).then(() => this.atomicWrite(this.target, data));
    return this.persistence;
  }

  list({ archived = false } = {}) {
    return this.tickets.filter((ticket) => archived || !ticket.archivedAt)
      .map(publicTicket).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id) {
    const ticket = this.tickets.find((item) => item.id === String(id));
    if (!ticket) throw new AuthError('Ticket not found', 404, 'ticket_not_found');
    return publicTicket(ticket);
  }

  mutable(id) {
    const ticket = this.tickets.find((item) => item.id === String(id));
    if (!ticket) throw new AuthError('Ticket not found', 404, 'ticket_not_found');
    return ticket;
  }

  addEvent(ticket, actor, type, details = {}) {
    ticket.events.push({
      id: crypto.randomUUID(), type, ...actorSummary(actor), at: new Date().toISOString(), details,
    });
    if (ticket.events.length > MAX_EVENTS) ticket.events.splice(0, ticket.events.length - MAX_EVENTS);
  }

  touch(ticket, actor) {
    if (actor?.id && !ticket.participantIds.includes(actor.id)) ticket.participantIds.push(actor.id);
    ticket.updatedAt = new Date().toISOString();
  }

  async create(actor, input) {
    if (this.tickets.length >= 2000) throw new AuthError('Ticket limit reached', 409, 'ticket_limit');
    const baseBranch = validBranch(input.baseBranch);
    const baseCommit = validCommit(input.baseCommit);
    await this.commitVerifier?.verify(baseBranch, baseCommit);
    const now = new Date().toISOString();
    const ticket = {
      id: crypto.randomUUID(),
      title: boundedText(input.title, 'Ticket title', 160, true),
      description: boundedText(input.description, 'Ticket description', 4000),
      baseBranch,
      baseCommit,
      files: ticketFiles(input.files),
      status: 'draft', creatorId: actor.id, creator: actor.displayName || 'Local user',
      participantIds: [actor.id], createdAt: now, updatedAt: now, archivedAt: '', events: [],
    };
    this.addEvent(ticket, actor, 'created', { files: ticket.files.length, baseCommit: ticket.baseCommit });
    this.tickets.push(ticket);
    await this.persist();
    return publicTicket(ticket);
  }

  async update(actor, id, input) {
    const ticket = this.mutable(id);
    if (ticket.archivedAt) throw new AuthError('Archived ticket is read-only', 409, 'ticket_archived');
    const changed = [];
    if (input.title !== undefined) {
      ticket.title = boundedText(input.title, 'Ticket title', 160, true);
      changed.push('title');
    }
    if (input.description !== undefined) {
      ticket.description = boundedText(input.description, 'Ticket description', 4000);
      changed.push('description');
    }
    if (input.status !== undefined) {
      const status = String(input.status);
      if (!USER_STATUSES.has(status)) {
        throw new AuthError('This ticket status is controlled by an operation', 409, 'protected_ticket_status');
      }
      if (ticket.status === 'applied') throw new AuthError('Applied ticket cannot be reopened', 409, 'ticket_applied');
      if (ticket.status !== status) {
        const previous = ticket.status;
        ticket.status = status;
        this.addEvent(ticket, actor, 'status_changed', { previous, status });
      }
    }
    if (changed.length) this.addEvent(ticket, actor, 'metadata_changed', { fields: changed });
    this.touch(ticket, actor);
    await this.persist();
    return publicTicket(ticket);
  }

  async setFiles(actor, id, files) {
    const ticket = this.mutable(id);
    if (['applied', 'closed'].includes(ticket.status) || ticket.archivedAt) {
      throw new AuthError('Ticket files cannot be changed now', 409, 'ticket_read_only');
    }
    const previous = ticket.files;
    ticket.files = ticketFiles(files);
    const added = ticket.files.filter((file) => !previous.includes(file));
    const removed = previous.filter((file) => !ticket.files.includes(file));
    this.addEvent(ticket, actor, 'files_changed', { added, removed });
    this.touch(ticket, actor);
    await this.persist();
    return { ticket: publicTicket(ticket), added, removed };
  }

  async systemStatus(actor, id, status, type, details = {}) {
    if (!STATUSES.has(status)) throw new AuthError('Ticket status is invalid', 400, 'invalid_ticket_status');
    const ticket = this.mutable(id);
    const previous = ticket.status;
    ticket.status = status;
    this.addEvent(ticket, actor, type, { previous, status, ...details });
    this.touch(ticket, actor);
    await this.persist();
    return publicTicket(ticket);
  }

  async setBase(actor, id, baseBranch, baseCommit) {
    const ticket = this.mutable(id);
    const previousCommit = ticket.baseCommit;
    const verifiedBranch = validBranch(baseBranch);
    const verifiedCommit = validCommit(baseCommit);
    await this.commitVerifier?.verify(verifiedBranch, verifiedCommit);
    ticket.baseBranch = verifiedBranch;
    ticket.baseCommit = verifiedCommit;
    ticket.status = 'in_progress';
    this.addEvent(ticket, actor, 'rebased', { previousCommit, baseCommit: ticket.baseCommit });
    this.touch(ticket, actor);
    await this.persist();
    return publicTicket(ticket);
  }

  async archive(actor, id) {
    const ticket = this.mutable(id);
    ticket.archivedAt = new Date().toISOString();
    if (ticket.status !== 'applied') ticket.status = 'closed';
    this.addEvent(ticket, actor, 'archived');
    this.touch(ticket, actor);
    await this.persist();
    return publicTicket(ticket);
  }

  async remove(actor, id) {
    const index = this.tickets.findIndex((item) => item.id === String(id));
    if (index < 0) throw new AuthError('Ticket not found', 404, 'ticket_not_found');
    const [ticket] = this.tickets.splice(index, 1);
    await this.persist();
    return publicTicket(ticket);
  }

  assertDocumentAccess(documentId) {
    const separator = documentId.indexOf(':');
    const namespace = documentId.slice(0, separator);
    if (!namespace.startsWith('ticket-')) return;
    const ticket = this.tickets.find((item) => item.id === namespace.slice('ticket-'.length));
    const relativePath = documentId.slice(separator + 1);
    if (!ticket || !ticket.files.includes(relativePath)) {
      throw new AuthError('Ticket document is unavailable', 403, 'ticket_document_unavailable');
    }
  }

  documentWritable(documentId) {
    const namespace = documentId.slice(0, documentId.indexOf(':'));
    if (!namespace.startsWith('ticket-')) return true;
    const ticket = this.tickets.find((item) => item.id === namespace.slice('ticket-'.length));
    return Boolean(ticket && !ticket.archivedAt && !['applied', 'closed'].includes(ticket.status));
  }

  async noteParticipant(documentId, actor) {
    const namespace = documentId.slice(0, documentId.indexOf(':'));
    if (!namespace.startsWith('ticket-') || !actor?.id) return;
    const ticket = this.tickets.find((item) => item.id === namespace.slice('ticket-'.length));
    if (!ticket || ticket.participantIds.includes(actor.id)) return;
    ticket.participantIds.push(actor.id);
    ticket.updatedAt = new Date().toISOString();
    await this.persist();
  }
}
