import crypto from 'node:crypto';
import { AuthError } from './auth.mjs';

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function decodedText(value, name) {
  const encoded = String(value ?? '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new AuthError(`${name} is invalid`, 400, 'invalid_ticket_operation');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > 8 * 1024 * 1024 || buffer.toString('base64') !== encoded) {
    throw new AuthError(`${name} is invalid`, 400, 'invalid_ticket_operation');
  }
  return buffer.toString('utf8');
}

function resultMap(ticket, body) {
  if (!Array.isArray(body.results) || body.results.length !== ticket.files.length) {
    throw new AuthError('A result is required for every ticket file', 400, 'invalid_ticket_operation');
  }
  const results = new Map(body.results.map((item) => [String(item.path), item]));
  if (results.size !== ticket.files.length || ticket.files.some((file) => !results.has(file))) {
    throw new AuthError('Ticket result files do not match', 400, 'invalid_ticket_operation');
  }
  return results;
}

function assertSameMutableTicket(ticketStore, original) {
  const current = ticketStore.get(original.id);
  if (current.archivedAt || ['applied', 'closed'].includes(current.status)) {
    throw new AuthError('Ticket is no longer writable', 409, 'ticket_read_only');
  }
  if (current.baseBranch !== original.baseBranch
      || current.baseCommit !== original.baseCommit
      || current.files.length !== original.files.length
      || current.files.some((file, index) => file !== original.files[index])) {
    throw new AuthError('Ticket changed during operation', 409, 'ticket_revision_changed');
  }
  return current;
}

export class TicketService {
  constructor(ticketStore, roomRegistry) {
    this.ticketStore = ticketStore;
    this.roomRegistry = roomRegistry;
  }

  ticketDocument(ticket, file) {
    return `ticket-${ticket.id}:${file}`;
  }

  mainDocument(ticket, file) {
    return `${ticket.baseBranch}:${file}`;
  }

  withRoomsLocked(rooms, operation) {
    return this.roomRegistry.withRoomsLocked
      ? this.roomRegistry.withRoomsLocked(rooms, operation)
      : operation();
  }

  async snapshot(id, requestedFile = '') {
    const ticket = this.ticketStore.get(id);
    if (requestedFile && !ticket.files.includes(requestedFile)) {
      throw new AuthError('Ticket file is unavailable', 404, 'ticket_file_not_found');
    }
    const files = [];
    for (const file of requestedFile ? [requestedFile] : ticket.files) {
      const ticketRoom = await this.roomRegistry.get(this.ticketDocument(ticket, file));
      const mainRoom = await this.roomRegistry.get(this.mainDocument(ticket, file));
      const ticketText = ticketRoom.currentText();
      const mainText = mainRoom.currentText();
      files.push({
        path: file,
        ticketInitialised: ticketRoom.hasAuthoritativeState(),
        mainInitialised: mainRoom.hasAuthoritativeState(),
        ticketHash: digest(ticketText),
        mainHash: digest(mainText),
        ticketTextBase64: Buffer.from(ticketText, 'utf8').toString('base64'),
        mainTextBase64: Buffer.from(mainText, 'utf8').toString('base64'),
      });
    }
    return { ticket, files };
  }

  async apply(actor, id, body) {
    const ticket = this.ticketStore.get(id);
    if (ticket.archivedAt || ['applied', 'closed'].includes(ticket.status)) {
      throw new AuthError('Ticket cannot be applied now', 409, 'ticket_read_only');
    }
    const supplied = resultMap(ticket, body);
    const roomPairs = [];
    for (const file of ticket.files) {
      const ticketRoom = await this.roomRegistry.get(this.ticketDocument(ticket, file));
      const mainRoom = await this.roomRegistry.get(this.mainDocument(ticket, file));
      roomPairs.push({ file, ticketRoom, mainRoom });
    }
    let prepared;
    let applied;
    await this.withRoomsLocked(roomPairs.flatMap(({ ticketRoom, mainRoom }) => [ticketRoom, mainRoom]), async () => {
      assertSameMutableTicket(this.ticketStore, ticket);
      prepared = roomPairs.map(({ file, ticketRoom, mainRoom }) => {
        const item = supplied.get(file);
        if (digest(ticketRoom.currentText()) !== String(item.ticketHash)
          || digest(mainRoom.currentText()) !== String(item.mainHash)) {
          throw new AuthError('Ticket or main document changed during apply', 409, 'ticket_revision_changed');
        }
        return {
          file,
          mainRoom,
          replacement: mainRoom.prepareReplacement(decodedText(item.textBase64, 'Applied text')),
        };
      });
      this.roomRegistry.assertBatchStateBudget(prepared.map((item) => ({
        room: item.mainRoom, stateBytes: item.replacement.stateBytes,
      })));
      for (const item of prepared) item.mainRoom.replacePrepared(item.replacement, actor, 'ticket-apply');
      applied = await this.ticketStore.systemStatus(actor, id, 'applied', 'applied', {
        files: prepared.length, baseCommit: ticket.baseCommit,
      });
    });
    await Promise.all(prepared.map((item) => item.mainRoom.flush()));
    return { ticket: applied };
  }

  async rebase(actor, id, body) {
    const ticket = this.ticketStore.get(id);
    if (ticket.archivedAt || ['applied', 'closed'].includes(ticket.status)) {
      throw new AuthError('Ticket cannot be rebased now', 409, 'ticket_read_only');
    }
    const supplied = resultMap(ticket, body);
    const verifiedBase = this.ticketStore.verifyBase
      ? await this.ticketStore.verifyBase(body.baseBranch, body.baseCommit)
      : null;
    const rooms = [];
    for (const file of ticket.files) {
      const ticketRoom = await this.roomRegistry.get(this.ticketDocument(ticket, file));
      rooms.push({ file, room: ticketRoom });
    }
    let prepared;
    let rebased;
    await this.withRoomsLocked(rooms.map(({ room }) => room), async () => {
      assertSameMutableTicket(this.ticketStore, ticket);
      prepared = rooms.map(({ file, room }) => {
        const item = supplied.get(file);
        if (digest(room.currentText()) !== String(item.ticketHash)) {
          throw new AuthError('Ticket changed during rebase', 409, 'ticket_revision_changed');
        }
        return {
          room,
          replacement: room.prepareReplacement(decodedText(item.textBase64, 'Rebased text')),
        };
      });
      this.roomRegistry.assertBatchStateBudget(prepared.map((item) => ({
        room: item.room, stateBytes: item.replacement.stateBytes,
      })));
      for (const item of prepared) item.room.replacePrepared(item.replacement, actor, 'ticket-rebase');
      rebased = verifiedBase
        ? await this.ticketStore.setVerifiedBase(actor, id, verifiedBase)
        : await this.ticketStore.setBase(actor, id, body.baseBranch, body.baseCommit);
    });
    await Promise.all(prepared.map((item) => item.room.flush()));
    return { ticket: rebased };
  }

  async setConflict(actor, id, operation, files) {
    return this.ticketStore.systemStatus(actor, id, 'git_conflict', 'git_conflict', {
      operation: String(operation).slice(0, 32), files: files.slice(0, 50),
    });
  }

  async setFiles(actor, id, files) {
    const before = this.ticketStore.get(id);
    const changed = await this.ticketStore.setFiles(actor, id, files);
    if (changed.removed.length) {
      await this.roomRegistry.deleteDocuments(
        changed.removed.map((file) => this.ticketDocument(before, file)),
        'Ticket file removed',
      );
    }
    return { ticket: changed.ticket };
  }

  async delete(actor, id) {
    const ticket = this.ticketStore.get(id);
    await this.roomRegistry.deleteDocuments(ticket.files.map((file) => this.ticketDocument(ticket, file)));
    return this.ticketStore.remove(actor, id);
  }
}
