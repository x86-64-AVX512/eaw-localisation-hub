import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { CrdtUpdateValidator, CrdtValidationError } from './crdt-validator.mjs';
import { DocumentHistory } from './document-history.mjs';
import {
  ProtocolLimitError,
  byteLength,
  controlledString,
  controlledText,
  sendWithBackpressure,
} from './protocol-limits.mjs';
import {
  minimalCommentThread,
  minimalDiscussionMessage,
  minimalReservation,
  minimalSuggestion,
} from './room-metadata.mjs';
import { expiredPresenceIds } from '../../../packages/shared/src/presence.mjs';
import { parseSuggestionTrace } from '../../../packages/shared/src/suggestion-trace.mjs';
import { mergeLocalisationThreeWay } from '../../../packages/shared/src/merge.mjs';
import { textChangeSummary } from './notification-summary.mjs';
import {
  DISPLAY_VERSION,
  MAX_CLIENTS_PER_ROOM,
  MAX_CRDT_UPDATE_BYTES,
  MAX_PRESENCES_PER_CONNECTION,
  MAX_ROOM_STATE_BYTES,
  PRESENCE_SWEEP_MILLISECONDS,
  PRESENCE_TTL_MILLISECONDS,
  PROTOCOL_VERSION,
} from '../../../packages/shared/src/constants.mjs';

const MAX_ROOM_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_RESERVATIONS_PER_ROOM = 500;
const MAX_COMMENT_THREADS_PER_ROOM = 500;
const MAX_SUGGESTIONS_PER_ROOM = 500;
const MAX_DISCUSSION_MESSAGES = 100;
const MAX_DISCUSSION_TEXT_BYTES = 2048;
const MAX_SUGGESTION_TEXT_BYTES = 16 * 1024;
const crdtValidator = new CrdtUpdateValidator({ maximumStateBytes: MAX_ROOM_STATE_BYTES });

export async function closeDocumentRoomValidator() {
  await crdtValidator.close();
}

export class DocumentRoom {
  static async load(dataDirectory, documentId, authStore, registry, canonicalSource = null) {
    const hash = crypto.createHash('sha256').update(documentId).digest('hex');
    const room = new DocumentRoom(dataDirectory, documentId, hash, authStore, registry, canonicalSource);
    await room.loadFromDisk();
    if (canonicalSource?.enabled) {
      await room.applyCanonicalSnapshot(await canonicalSource.snapshot(documentId));
    }
    return room;
  }

  constructor(dataDirectory, documentId, hash, authStore, registry, canonicalSource = null) {
    this.documentId = documentId;
    this.hash = hash;
    this.document = new Y.Doc();
    this.clients = new Set();
    this.seedClaimed = false;
    this.hasStoredState = false;
    this.reservations = [];
    this.commentThreads = [];
    this.suggestions = [];
    this.gitBase = null;
    this.gitConflict = false;
    this.pendingGitSnapshot = null;
    this.gitConflictResolutions = {};
    this.canonicalSource = canonicalSource;
    this.presences = new Map();
    this.presenceLastSeen = new Map();
    this.presenceOwners = new Map();
    this.updatePath = path.join(dataDirectory, 'documents', `${hash}.update`);
    this.metadataPath = path.join(dataDirectory, 'documents', `${hash}.json`);
    this.historyPath = path.join(dataDirectory, 'documents', `${hash}.history.json`);
    this.history = new DocumentHistory(this.historyPath);
    this.persistTimer = null;
    this.persistPromise = Promise.resolve();
    this.messageQueue = Promise.resolve();
    this.authStore = authStore;
    this.registry = registry;
    this.stateBudgetBytes = 0;
    this.revision = 0;
    this.persistedBytes = registry.persistedBytesFor(hash);
    this.lastAccessAt = Date.now();
    this.destroyed = false;
    this.presenceTimer = setInterval(() => this.expirePresences(), PRESENCE_SWEEP_MILLISECONDS);
    this.presenceTimer.unref();

    this.document.on('update', (update, origin) => {
      if (origin === 'disk') return;
      this.hasStoredState = true;
      this.revision += 1;
      const source = origin?.socket ?? origin;
      const account = origin?.actor ?? (!this.authStore.required
        ? source?.localActor ?? null
        : source?.identity
          ? this.authStore.findDirectoryUser(source.identity, source.identity.id) ?? source.identity
          : null);
      const currentText = this.document.getText('content').toString();
      const previousText = this.eventText ?? currentText;
      this.eventText = currentText;
      if (this.documentId.startsWith('ticket-') && account?.id && previousText !== currentText) {
        const ticketId = this.documentId.slice('ticket-'.length, this.documentId.indexOf(':'));
        try {
          const ticket = this.registry.ticketStore?.mutable(ticketId);
          this.registry.eventJournal?.append('ticket-edited', account, [ticket?.creatorId], {
            ticketId, ticketTitle: ticket?.title ?? '', documentId: this.documentId,
            ...textChangeSummary(previousText, currentText),
          });
        } catch { /* ticket may have been removed concurrently */ }
      }
      const historyChanged = this.history.record(
        currentText, account, origin?.historyReason ?? 'edit',
      );
      this.schedulePersist();
      for (const client of this.clients) {
        if (client !== origin && client.readyState === WebSocket.OPEN) {
          sendWithBackpressure(client, update, { binary: true });
        }
      }
      if (historyChanged) this.broadcastHistory();
    });
  }

  async loadFromDisk() {
    try {
      const stats = await fs.stat(this.updatePath);
      if (stats.size > MAX_ROOM_STATE_BYTES) {
        throw new ProtocolLimitError('Persisted document exceeds the room state limit');
      }
      const update = await fs.readFile(this.updatePath);
      Y.applyUpdate(this.document, update, 'disk');
      this.hasStoredState = true;
      const encoded = Y.encodeStateAsUpdate(this.document);
      if (encoded.byteLength > MAX_ROOM_STATE_BYTES) {
        throw new ProtocolLimitError('Persisted document exceeds the room state limit');
      }
      this.stateBudgetBytes = encoded.byteLength;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.history.load();
    this.eventText = this.document.getText('content').toString();
    this.history.ensureBaseline(this.document.getText('content').toString());
    try {
      const stats = await fs.stat(this.metadataPath);
      if (stats.size > MAX_ROOM_METADATA_BYTES) {
        throw new ProtocolLimitError('Persisted room metadata exceeds the server limit');
      }
      const metadata = JSON.parse(await fs.readFile(this.metadataPath, 'utf8'));
      this.reservations = (Array.isArray(metadata.reservations) ? metadata.reservations : [])
        .filter((reservation) => !reservation.deletedAt)
        .slice(0, MAX_RESERVATIONS_PER_ROOM)
        .map(minimalReservation);
      this.commentThreads = (Array.isArray(metadata.commentThreads) ? metadata.commentThreads : [])
        .slice(0, MAX_COMMENT_THREADS_PER_ROOM)
        .map(minimalCommentThread);
      this.suggestions = (Array.isArray(metadata.suggestions) ? metadata.suggestions : [])
        .slice(0, MAX_SUGGESTIONS_PER_ROOM)
        .map(minimalSuggestion);
      if (metadata.gitBase && typeof metadata.gitBase === 'object') {
        this.gitBase = {
          branch: String(metadata.gitBase.branch ?? ''),
          commit: String(metadata.gitBase.commit ?? ''),
          blob: String(metadata.gitBase.blob ?? ''),
          checkedAt: Number(metadata.gitBase.checkedAt ?? 0),
          changedFiles: Array.isArray(metadata.gitBase.changedFiles)
            ? metadata.gitBase.changedFiles.map(String).slice(0, 5000) : [],
          text: String(metadata.gitBase.text ?? ''),
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  addClient(socket) {
    if (this.clients.size >= MAX_CLIENTS_PER_ROOM) {
      throw new ProtocolLimitError('This document already has too many connected clients', 1013);
    }
    this.clients.add(socket);
    socket.presenceIds = new Set();
    this.lastAccessAt = Date.now();
    const content = this.document.getText('content');
    socket.gitWritable = !this.gitBase || Boolean(socket.localBlob && socket.localBlob === this.gitBase.blob);
    const canSeed = !this.gitBase && content.length === 0 && !this.seedClaimed;
    if (canSeed) this.seedClaimed = true;
    if (!sendWithBackpressure(socket, Y.encodeStateAsUpdate(this.document), { binary: true })) return;
    this.expirePresences();
    sendWithBackpressure(socket, JSON.stringify({
      type: 'synced',
      protocol: PROTOCOL_VERSION,
      version: DISPLAY_VERSION,
      documentId: this.documentId,
      canSeed,
      git: this.gitBase ? {
        status: socket.gitWritable
          ? (socket.localHead === this.gitBase.commit ? 'current' : 'branch-outdated')
          : 'file-outdated',
        branch: this.gitBase.branch,
        localHead: socket.localHead ?? '',
        remoteHead: this.gitBase.commit,
        localBlob: socket.localBlob ?? '',
        remoteBlob: this.gitBase.blob,
        changedFiles: socket.changedFiles?.length ? socket.changedFiles : (this.gitBase.changedFiles ?? []),
        reason: !socket.localBlob ? 'local-file-not-in-head'
          : socket.gitWritable ? 'branch-head-outdated' : 'file-blob-differs',
        checkedAt: this.gitBase.checkedAt,
      } : null,
      reservations: this.activeReservations(),
      commentThreads: this.commentThreads,
      suggestions: this.suggestions,
      history: this.history.summaries(),
      historyHeadId: this.history.headId(),
      presences: [...this.presences.values()],
      identity: socket.identity ? {
        id: socket.identity.id,
        displayName: socket.identity.displayName,
        roles: socket.identity.roles,
        avatarBase64: socket.identity.avatarBase64 ?? '',
      } : null,
      directory: this.authStore.directory(socket.identity),
    }));
  }

  clientWritable(socket) {
    return socket.gitWritable !== false && !this.gitConflict;
  }

  gitStatusFor(client, snapshot = this.gitBase) {
    const writable = Boolean(client.localBlob && client.localBlob === snapshot.blob);
    const changedFiles = [...new Set([
      ...(client.changedFiles ?? []), ...(snapshot.changedFiles ?? []),
    ])].slice(0, 500);
    client.changedFiles = changedFiles;
    return {
      type: 'git-status',
      status: writable ? (client.localHead === snapshot.commit ? 'current' : 'branch-outdated') : 'file-outdated',
      branch: snapshot.branch,
      localHead: client.localHead ?? '', remoteHead: snapshot.commit,
      localBlob: client.localBlob ?? '', remoteBlob: snapshot.blob,
      changedFiles,
      reason: !client.localBlob ? 'local-file-not-in-head'
        : writable ? 'branch-head-outdated' : 'file-blob-differs',
      message: writable ? 'A newer canonical branch commit is available' : 'A newer canonical commit changed this file',
    };
  }

  broadcastGitConflict(snapshot, conflicts) {
    this.broadcastJson({
      type: 'git-status', status: 'conflict', branch: snapshot.branch,
      remoteHead: snapshot.commit, remoteBlob: snapshot.blob,
      changedFiles: (snapshot.changedFiles ?? []).slice(0, 500),
      conflicts: conflicts.slice(0, 1000).map((item) => ({
        key: item.key, label: item.label,
        baseLine: String(item.baseLine ?? '').slice(0, 60 * 1024),
        collaborativeLine: String(item.collaborativeLine ?? '').slice(0, 60 * 1024),
        externalLine: String(item.externalLine ?? '').slice(0, 60 * 1024),
        detail: item.key === '__file_structure__'
          ? 'Комментарии или структура файла изменены с обеих сторон.'
          : item.key === '__duplicate_keys__'
            ? 'В файле есть повторяющиеся ключи; выбор применяется ко всему файлу.'
            : 'Один и тот же ключ изменён в Git и в совместном документе.',
      })),
      message: 'Canonical Git update conflicts with live edits',
    });
  }

  finishCanonicalSnapshot(snapshot, merged) {
    this.gitConflict = false;
    this.pendingGitSnapshot = null;
    this.gitConflictResolutions = {};
    this.gitBase = { ...snapshot };
    for (const client of this.clients) {
      const status = this.gitStatusFor(client, snapshot);
      client.gitWritable = ['current', 'branch-outdated'].includes(status.status);
      if (client.readyState === WebSocket.OPEN) sendWithBackpressure(client, JSON.stringify(status));
    }
    if (merged.changed) this.replaceText(merged.text, null, 'git-refresh');
    else this.schedulePersist();
  }

  async applyCanonicalSnapshot(snapshot) {
    if (!snapshot) return;
    const current = this.document.getText('content').toString();
    if (!this.gitBase) {
      this.gitBase = { ...snapshot };
      if (!current && snapshot.text) this.replaceText(snapshot.text, null, 'git-base');
      this.schedulePersist();
      return;
    }
    if (this.gitBase.commit === snapshot.commit && this.gitBase.blob === snapshot.blob) {
      this.gitBase.checkedAt = snapshot.checkedAt;
      return;
    }
    const continuingConflict = this.pendingGitSnapshot?.blob === snapshot.blob;
    const merged = mergeLocalisationThreeWay(
      this.gitBase.text, current, snapshot.text,
      continuingConflict ? this.gitConflictResolutions : {},
    );
    if (merged.conflicts.length > 0) {
      this.gitConflict = true;
      if (!continuingConflict) this.gitConflictResolutions = {};
      this.pendingGitSnapshot = { ...snapshot };
      this.broadcastGitConflict(snapshot, merged.conflicts);
      return;
    }
    this.finishCanonicalSnapshot(snapshot, merged);
  }

  async refreshCanonical() {
    if (!this.canonicalSource?.enabled || this.clients.size === 0) return;
    await this.applyCanonicalSnapshot(await this.canonicalSource.snapshot(this.documentId, { force: true }));
  }

  broadcastDirectory() {
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      sendWithBackpressure(client, JSON.stringify({
        type: 'directory',
        users: this.authStore.directory(client.identity),
      }));
    }
  }

  currentText() {
    this.lastAccessAt = Date.now();
    return this.document.getText('content').toString();
  }

  hasAuthoritativeState() {
    return this.hasStoredState || this.seedClaimed || this.document.getText('content').length > 0;
  }

  prepareReplacement(nextText) {
    const value = controlledText(nextText, 'Document text', MAX_ROOM_STATE_BYTES);
    const candidate = new Y.Doc();
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
    const candidateText = candidate.getText('content');
    if (candidateText.length) candidateText.delete(0, candidateText.length);
    if (value) candidateText.insert(0, value);
    const candidateBytes = Y.encodeStateAsUpdate(candidate).byteLength;
    candidate.destroy();
    return { value, stateBytes: candidateBytes };
  }

  replacePrepared(prepared, actor, historyReason = 'ticket-operation') {
    this.document.transact(() => {
      const content = this.document.getText('content');
      if (content.length) content.delete(0, content.length);
      if (prepared.value) content.insert(0, prepared.value);
    }, { actor, historyReason });
    this.stateBudgetBytes = Y.encodeStateAsUpdate(this.document).byteLength;
    this.lastAccessAt = Date.now();
  }

  replaceText(nextText, actor, historyReason = 'ticket-operation') {
    const prepared = this.prepareReplacement(nextText);
    this.registry.assertStateBudget(this, prepared.stateBytes);
    this.replacePrepared(prepared, actor, historyReason);
  }

  removeClient(socket) {
    this.clients.delete(socket);
    this.lastAccessAt = Date.now();
    for (const clientId of socket.presenceIds ?? []) {
      this.presences.delete(clientId);
      this.presenceLastSeen.delete(clientId);
      this.presenceOwners.delete(clientId);
      this.broadcastJson({ type: 'presence-left', clientId });
    }
    socket.presenceIds?.clear();
  }

  expirePresences(now = Date.now()) {
    for (const clientId of expiredPresenceIds(this.presenceLastSeen, now, PRESENCE_TTL_MILLISECONDS)) {
      this.presenceLastSeen.delete(clientId);
      if (this.presences.delete(clientId)) {
        const owner = this.presenceOwners.get(clientId);
        owner?.presenceIds?.delete(clientId);
        this.presenceOwners.delete(clientId);
        this.broadcastJson({ type: 'presence-left', clientId });
      }
    }
  }

  activeReservations() {
    return this.reservations;
  }

  actorFor(socket, message, label) {
    const actor = this.authStore.required
      ? this.authStore.findDirectoryUser(socket.identity, socket.identity?.id)
      : {
          id: `local:${String(socket.identity?.displayName ?? message.author ?? 'unknown').trim().toLowerCase()}`,
          displayName: socket.identity?.displayName ?? controlledString(
            message.author ?? 'Unknown', `${label} author`, 128, { required: true },
          ),
          color: controlledString(message.color ?? '#8a8a8a', `${label} color`, 16, { required: true }),
        };
    if (!actor) throw new Error(`${label} author account is unavailable`);
    if (!this.authStore.required) socket.localActor = actor;
    return actor;
  }

  notifyTicketOwner(action, actor, details = {}) {
    if (!this.documentId.startsWith('ticket-')) return;
    const ticketId = this.documentId.slice('ticket-'.length, this.documentId.indexOf(':'));
    try {
      const ticket = this.registry.ticketStore?.mutable(ticketId);
      this.registry.eventJournal?.append('ticket-activity', actor, [ticket?.creatorId], {
        ticketId, ticketTitle: ticket?.title ?? '', documentId: this.documentId, action, ...details,
      });
    } catch { /* ticket may have been removed concurrently */ }
  }

  resolveRelativeRange(item) {
    try {
      const start = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(Buffer.from(item.startRelative, 'base64')),
        this.document,
      );
      const end = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(Buffer.from(item.endRelative, 'base64')),
        this.document,
      );
      const text = this.document.getText('content');
      if (!start || !end || start.type !== text || end.type !== text) return null;
      return { text, start: Math.min(start.index, end.index), end: Math.max(start.index, end.index) };
    } catch {
      return null;
    }
  }

  anchorSuggestionRange(suggestion, text, start, end) {
    suggestion.startRelative = Buffer.from(Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, start, 0),
    )).toString('base64');
    suggestion.endRelative = Buffer.from(Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, end, -1),
    )).toString('base64');
  }

  appendDiscussionMessage(target, actor, message) {
    if (target.messages.length >= MAX_DISCUSSION_MESSAGES) {
      throw new ProtocolLimitError('This discussion has reached its message limit');
    }
    const id = controlledString(message.messageId, 'Discussion message id', 128, { required: true });
    if (target.messages.some((item) => item.id === id)) return false;
    const body = controlledText(message.body, 'Discussion message', MAX_DISCUSSION_TEXT_BYTES, { required: true });
    if (!body.trim()) throw new ProtocolLimitError('Discussion message must contain visible text');
    target.messages.push({
      id,
      authorId: actor.id,
      author: actor.displayName,
      color: actor.color ?? '#8a8a8a',
      body,
      createdAt: new Date().toISOString(),
    });
    try {
      this.assertMetadataBudget();
    } catch (error) {
      target.messages.pop();
      throw error;
    }
    return true;
  }

  assertMetadataBudget() {
    const bytes = byteLength(JSON.stringify({
      reservations: this.reservations,
      commentThreads: this.commentThreads,
      suggestions: this.suggestions,
      gitBase: this.gitBase,
    }));
    if (bytes > MAX_ROOM_METADATA_BYTES) {
      throw new ProtocolLimitError('Room metadata exceeds the persistence limit');
    }
  }

  receiveBinary(socket, update) {
    const incoming = Uint8Array.from(update);
    if (incoming.byteLength === 0 || incoming.byteLength > MAX_CRDT_UPDATE_BYTES) {
      throw new ProtocolLimitError('CRDT update exceeds the per-message limit');
    }

    return this.enqueueMessage(() => this.applyBinary(socket, incoming));
  }

  async applyBinary(socket, incoming) {
    if (this.destroyed || socket.readyState !== WebSocket.OPEN) return;

    let projectedBytes = this.stateBudgetBytes + incoming.byteLength;
    if (projectedBytes > MAX_ROOM_STATE_BYTES) {
      throw new ProtocolLimitError('Document state exceeds the per-room limit');
    }
    this.registry.assertStateBudget(this, projectedBytes);

    // Every untrusted update is decoded in a worker before the main event loop
    // sees it. Large seeds additionally include the current state so the worker
    // can calculate the exact resulting room budget.
    const baseUpdate = incoming.byteLength >= 256 * 1024
      ? Y.encodeStateAsUpdate(this.document)
      : null;
    try {
      const validation = await crdtValidator.validate(incoming, baseUpdate);
      if (baseUpdate) projectedBytes = validation.stateBytes;
    } catch (error) {
      if (error instanceof CrdtValidationError) {
        throw new ProtocolLimitError(error.message, error.code === 'crdt-validation-overloaded' ? 1013 : 1008);
      }
      throw error;
    }
    if (this.destroyed || socket.readyState !== WebSocket.OPEN) return;
    if (projectedBytes > MAX_ROOM_STATE_BYTES) throw new ProtocolLimitError('Document state exceeds the per-room limit');
    this.registry.assertStateBudget(this, projectedBytes);

    Y.applyUpdate(this.document, incoming, socket);
    this.stateBudgetBytes = projectedBytes;
    this.lastAccessAt = Date.now();
  }

  receiveJson(socket, message) {
    return this.enqueueMessage(() => this.applyJson(socket, message));
  }

  enqueueMessage(operation) {
    const result = this.messageQueue.then(() => operation());
    this.messageQueue = result.catch(() => {});
    return result;
  }

  applyJson(socket, message) {
    if (this.destroyed || socket.readyState !== WebSocket.OPEN) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new ProtocolLimitError('Control message must be a JSON object');
    }
    if (message.type === 'git-conflict-resolve') {
      if (!this.gitConflict || !this.pendingGitSnapshot || !this.gitBase) return;
      const key = controlledString(message.key, 'Git conflict key', 512, { required: true });
      const choice = controlledString(message.choice, 'Git conflict choice', 32, { required: true });
      if (!['collaborative', 'external'].includes(choice)) {
        throw new ProtocolLimitError('Git conflict choice is invalid');
      }
      this.gitConflictResolutions[key] = choice;
      const merged = mergeLocalisationThreeWay(
        this.gitBase.text,
        this.document.getText('content').toString(),
        this.pendingGitSnapshot.text,
        this.gitConflictResolutions,
      );
      if (merged.conflicts.length > 0) {
        this.broadcastGitConflict(this.pendingGitSnapshot, merged.conflicts);
      } else {
        this.finishCanonicalSnapshot(this.pendingGitSnapshot, merged);
      }
      return;
    }
    if (message.type === 'presence') {
      const clientId = controlledString(message.clientId, 'Presence client id', 128, { required: true });
      const owner = this.presenceOwners.get(clientId);
      if (owner && owner !== socket) {
        throw new ProtocolLimitError('Presence id is already owned by another connection');
      }
      if (message.offline) {
        this.presences.delete(clientId);
        this.presenceLastSeen.delete(clientId);
        this.presenceOwners.delete(clientId);
        socket.presenceIds?.delete(clientId);
        this.broadcastJson({ type: 'presence-left', clientId }, socket);
      } else {
        if (!socket.presenceIds?.has(clientId)
            && (socket.presenceIds?.size ?? 0) >= MAX_PRESENCES_PER_CONNECTION) {
          throw new ProtocolLimitError('Connection has too many active presences');
        }
        socket.presenceIds ??= new Set();
        socket.presenceIds.add(clientId);
        this.presenceOwners.set(clientId, socket);
        const account = this.authStore.findDirectoryUser(socket.identity, socket.identity?.id);
        const presence = {
          type: 'presence',
          clientId,
          user: socket.identity?.displayName ?? String(message.user ?? 'Unknown'),
          color: account?.color ?? String(message.color ?? '#6aa9ff'),
          caretRelative: controlledString(message.caretRelative, 'Caret position', 4096),
          anchorRelative: controlledString(message.anchorRelative, 'Anchor position', 4096),
        };
        this.presences.set(clientId, presence);
        this.presenceLastSeen.set(clientId, Date.now());
        this.broadcastJson(presence, socket);
      }
      return;
    }

    if (message.type === 'reservation-create') {
      const id = controlledString(message.id, 'Reservation id', 128, { required: true });
      const startRelative = controlledString(message.startRelative, 'Reservation start', 4096, { required: true });
      const endRelative = controlledString(message.endRelative, 'Reservation end', 4096, { required: true });
      const initialKeys = Array.isArray(message.initialKeys) ? message.initialKeys : [];
      if (initialKeys.length > 1000) throw new ProtocolLimitError('Reservation contains too many keys');
      const existing = this.reservations.find((reservation) => reservation.id === id);
      if (!existing) {
        if (this.reservations.length >= MAX_RESERVATIONS_PER_ROOM) {
          throw new ProtocolLimitError('This document has reached its reservation limit');
        }
        const actor = this.authStore.required
          ? this.authStore.findDirectoryUser(socket.identity, socket.identity?.id)
          : {
              id: null,
              displayName: socket.identity?.displayName ?? controlledString(
                message.createdBy ?? message.assignee ?? 'Unknown', 'Reservation creator', 128, { required: true },
              ),
              color: controlledString(message.color ?? '#6aa9ff', 'Reservation color', 16, { required: true }),
            };
        if (!actor) throw new Error('Reservation creator account is unavailable');
        const assignee = this.authStore.required
          ? this.authStore.findDirectoryUser(socket.identity, message.assigneeId || actor.id)
          : {
              id: message.assigneeId
                ? controlledString(message.assigneeId, 'Reservation assignee id', 128, { required: true })
                : null,
              displayName: controlledString(
                message.assignee ?? actor.displayName, 'Reservation assignee', 128, { required: true },
              ),
              color: controlledString(
                message.assigneeColor ?? message.color ?? actor.color,
                'Reservation assignee color', 16, { required: true },
              ),
            };
        if (!assignee) throw new Error('Reservation assignee account is unavailable');
        this.reservations.push({
          id,
          assigneeId: assignee.id,
          assignee: assignee.displayName,
          color: assignee.color,
          createdById: actor.id,
          createdBy: actor.displayName,
          comment: controlledString(message.comment, 'Reservation comment', 1024),
          startRelative,
          endRelative,
          initialKeys: initialKeys.map((key) => controlledString(key, 'Localisation key', 256, { required: true })),
        });
        try {
          this.assertMetadataBudget();
        } catch (error) {
          this.reservations.pop();
          throw error;
        }
        this.schedulePersist();
      }
      this.broadcastReservations();
      return;
    }

    if (message.type === 'reservation-delete') {
      const id = controlledString(message.id, 'Reservation id', 128, { required: true });
      const previousLength = this.reservations.length;
      this.reservations = this.reservations.filter((reservation) => reservation.id !== id);
      if (this.reservations.length !== previousLength) {
        this.schedulePersist();
      }
      this.broadcastReservations();
      return;
    }

    if (message.type === 'comment-create') {
      const id = controlledString(message.id, 'Comment thread id', 128, { required: true });
      if (!this.commentThreads.some((thread) => thread.id === id)) {
        if (this.commentThreads.length >= MAX_COMMENT_THREADS_PER_ROOM) {
          throw new ProtocolLimitError('This document has reached its comment limit');
        }
        const actor = this.actorFor(socket, message, 'Comment');
        const thread = {
          id,
          authorId: actor.id,
          author: actor.displayName,
          color: actor.color ?? '#8a8a8a',
          status: 'open',
          createdAt: new Date().toISOString(),
          startRelative: controlledString(message.startRelative, 'Comment start', 4096, { required: true }),
          endRelative: controlledString(message.endRelative, 'Comment end', 4096, { required: true }),
          messages: [],
        };
        this.commentThreads.push(thread);
        try {
          this.appendDiscussionMessage(thread, actor, message);
          this.assertMetadataBudget();
        } catch (error) {
          this.commentThreads.pop();
          throw error;
        }
        this.schedulePersist();
        this.notifyTicketOwner('comment-created', actor, { discussionId: thread.id });
      }
      this.broadcastReview();
      return;
    }

    if (message.type === 'comment-reply') {
      const id = controlledString(message.id, 'Comment thread id', 128, { required: true });
      const thread = this.commentThreads.find((item) => item.id === id);
      if (!thread) throw new Error('Comment thread no longer exists');
      const actor = this.actorFor(socket, message, 'Comment');
      if (this.appendDiscussionMessage(thread, actor, message)) {
        this.registry.eventJournal?.append('comment-reply', actor, [thread.authorId], {
          documentId: this.documentId, discussionId: thread.id,
        });
        this.notifyTicketOwner('comment-replied', actor, { discussionId: thread.id });
        this.schedulePersist();
      }
      this.broadcastReview();
      return;
    }

    if (message.type === 'comment-status') {
      const id = controlledString(message.id, 'Comment thread id', 128, { required: true });
      const status = controlledString(message.status, 'Comment status', 16, { required: true });
      if (!['open', 'resolved'].includes(status)) throw new ProtocolLimitError('Invalid comment status');
      const thread = this.commentThreads.find((item) => item.id === id);
      if (thread && thread.status !== status) {
        const actor = this.actorFor(socket, message, 'Comment');
        thread.status = status;
        this.notifyTicketOwner('comment-status', actor, { discussionId: thread.id, status });
        this.schedulePersist();
      }
      this.broadcastReview();
      return;
    }

    if (message.type === 'comment-delete') {
      const id = controlledString(message.id, 'Comment thread id', 128, { required: true });
      const previousLength = this.commentThreads.length;
      this.commentThreads = this.commentThreads.filter((item) => item.id !== id);
      if (this.commentThreads.length !== previousLength) this.schedulePersist();
      this.broadcastReview();
      return;
    }

    if (message.type === 'suggestion-create') {
      const id = controlledString(message.id, 'Suggestion id', 128, { required: true });
      if (!this.suggestions.some((suggestion) => suggestion.id === id)) {
        if (this.suggestions.length >= MAX_SUGGESTIONS_PER_ROOM) {
          throw new ProtocolLimitError('This document has reached its suggestion limit');
        }
        const actor = this.actorFor(socket, message, 'Suggestion');
        const originalText = controlledText(
          message.originalText, 'Suggestion original text', MAX_SUGGESTION_TEXT_BYTES,
        );
        const replacementText = controlledText(
          message.replacementText, 'Suggestion replacement text', MAX_SUGGESTION_TEXT_BYTES,
        );
        const traceJson = controlledString(message.traceJson ?? '', 'Suggestion trace', 64 * 1024);
        if (traceJson) parseSuggestionTrace(traceJson, originalText, replacementText);
        if (!originalText && !replacementText) {
          throw new ProtocolLimitError('Suggestion must insert or delete text');
        }
        this.suggestions.push({
          id,
          authorId: actor.id,
          author: actor.displayName,
          color: actor.color ?? '#8a8a8a',
          status: 'open',
          createdAt: new Date().toISOString(),
          decidedById: null,
          decidedBy: null,
          startRelative: controlledString(message.startRelative, 'Suggestion start', 4096, { required: true }),
          endRelative: controlledString(message.endRelative, 'Suggestion end', 4096, { required: true }),
          originalText,
          replacementText,
          traceJson,
          messages: [],
        });
        try {
          this.assertMetadataBudget();
        } catch (error) {
          this.suggestions.pop();
          throw error;
        }
        this.schedulePersist();
        this.notifyTicketOwner('suggestion-created', actor, { suggestionId: id });
      }
      this.broadcastReview();
      return;
    }

    if (message.type === 'suggestion-reply') {
      const id = controlledString(message.id, 'Suggestion id', 128, { required: true });
      const suggestion = this.suggestions.find((item) => item.id === id);
      if (!suggestion) throw new Error('Suggestion no longer exists');
      const actor = this.actorFor(socket, message, 'Suggestion');
      if (this.appendDiscussionMessage(suggestion, actor, message)) {
        this.registry.eventJournal?.append('comment-reply', actor, [suggestion.authorId], {
          documentId: this.documentId, discussionId: suggestion.id,
        });
        this.notifyTicketOwner('suggestion-replied', actor, { suggestionId: suggestion.id });
        this.schedulePersist();
      }
      this.broadcastReview();
      return;
    }

    if (message.type === 'suggestion-update') {
      const id = controlledString(message.id, 'Suggestion id', 128, { required: true });
      const suggestion = this.suggestions.find((item) => item.id === id);
      if (!suggestion || suggestion.status !== 'open') {
        throw new ProtocolLimitError('Suggestion is no longer editable');
      }
      const actor = this.actorFor(socket, message, 'Suggestion');
      const sameAuthor = suggestion.authorId
        ? suggestion.authorId === actor.id
        : suggestion.author === actor.displayName;
      if (!sameAuthor) throw new ProtocolLimitError('Only the suggestion author may update its draft');
      const next = {
        startRelative: controlledString(message.startRelative, 'Suggestion start', 4096, { required: true }),
        endRelative: controlledString(message.endRelative, 'Suggestion end', 4096, { required: true }),
        originalText: controlledText(message.originalText, 'Suggestion original text', MAX_SUGGESTION_TEXT_BYTES),
        replacementText: controlledText(message.replacementText, 'Suggestion replacement text', MAX_SUGGESTION_TEXT_BYTES),
        traceJson: controlledString(message.traceJson ?? '', 'Suggestion trace', 64 * 1024),
      };
      if (next.traceJson) parseSuggestionTrace(next.traceJson, next.originalText, next.replacementText);
      if (!next.originalText && !next.replacementText) {
        throw new ProtocolLimitError('Suggestion must insert or delete text');
      }
      const previous = {
        startRelative: suggestion.startRelative,
        endRelative: suggestion.endRelative,
        originalText: suggestion.originalText,
        replacementText: suggestion.replacementText,
        traceJson: suggestion.traceJson ?? '',
      };
      Object.assign(suggestion, next);
      try {
        this.assertMetadataBudget();
      } catch (error) {
        Object.assign(suggestion, previous);
        throw error;
      }
      this.schedulePersist();
      this.broadcastReview();
      return;
    }

    if (message.type === 'suggestion-accept') {
      const id = controlledString(message.id, 'Suggestion id', 128, { required: true });
      const suggestion = this.suggestions.find((item) => item.id === id);
      if (!suggestion || suggestion.status !== 'open') {
        this.broadcastReview();
        return;
      }
      const actor = this.actorFor(socket, message, 'Suggestion');
      const resolved = this.resolveRelativeRange(suggestion);
      const current = resolved?.text.toString().slice(resolved.start, resolved.end);
      if (!resolved || current !== suggestion.originalText) {
        suggestion.status = 'stale';
        suggestion.decidedById = actor.id;
        suggestion.decidedBy = actor.displayName;
        this.schedulePersist();
        this.broadcastReview();
        return;
      }
      const candidate = new Y.Doc();
      let projectedBytes;
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
        const candidateText = candidate.getText('content');
        candidateText.delete(resolved.start, resolved.end - resolved.start);
        if (suggestion.replacementText) candidateText.insert(resolved.start, suggestion.replacementText);
        projectedBytes = Y.encodeStateAsUpdate(candidate).byteLength;
        if (projectedBytes > MAX_ROOM_STATE_BYTES) {
          throw new ProtocolLimitError('Accepted suggestion would exceed the room state limit');
        }
        this.registry.assertStateBudget(this, projectedBytes);
      } finally {
        candidate.destroy();
      }
      suggestion.status = 'accepted';
      suggestion.decidedById = actor.id;
      suggestion.decidedBy = actor.displayName;
      this.registry.eventJournal?.append('suggestion-decision', actor, [suggestion.authorId], {
        documentId: this.documentId, suggestionId: suggestion.id, decision: 'accepted',
      });
      this.notifyTicketOwner('suggestion-accepted', actor, { suggestionId: suggestion.id });
      const textActor = suggestion.authorId && this.authStore.required
        ? this.authStore.findDirectoryUser(actor, suggestion.authorId) ?? actor
        : actor;
      this.document.transact(() => {
        resolved.text.delete(resolved.start, resolved.end - resolved.start);
        if (suggestion.replacementText) resolved.text.insert(resolved.start, suggestion.replacementText);
        this.anchorSuggestionRange(
          suggestion,
          resolved.text,
          resolved.start,
          resolved.start + suggestion.replacementText.length,
        );
      }, { socket, historyReason: 'suggestion', actor: textActor });
      this.stateBudgetBytes = projectedBytes;
      this.schedulePersist();
      this.broadcastReview();
      return;
    }

    if (message.type === 'suggestion-revert') {
      const id = controlledString(message.id, 'Suggestion id', 128, { required: true });
      const suggestion = this.suggestions.find((item) => item.id === id);
      if (!suggestion || suggestion.status !== 'accepted') { this.broadcastReview(); return; }
      const actor = this.actorFor(socket, message, 'Suggestion');
      const resolved = this.resolveRelativeRange(suggestion);
      const current = resolved?.text.toString().slice(resolved.start, resolved.end);
      if (!resolved || current !== suggestion.replacementText) {
        throw new ProtocolLimitError('Accepted suggestion can no longer be reverted because its text changed');
      }
      const candidate = new Y.Doc();
      let projectedBytes;
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
        const candidateText = candidate.getText('content');
        candidateText.delete(resolved.start, resolved.end - resolved.start);
        if (suggestion.originalText) candidateText.insert(resolved.start, suggestion.originalText);
        projectedBytes = Y.encodeStateAsUpdate(candidate).byteLength;
        if (projectedBytes > MAX_ROOM_STATE_BYTES) throw new ProtocolLimitError('Reverted suggestion would exceed the room state limit');
        this.registry.assertStateBudget(this, projectedBytes);
      } finally { candidate.destroy(); }
      suggestion.status = 'open';
      suggestion.decidedById = null;
      suggestion.decidedBy = null;
      this.document.transact(() => {
        resolved.text.delete(resolved.start, resolved.end - resolved.start);
        if (suggestion.originalText) resolved.text.insert(resolved.start, suggestion.originalText);
        this.anchorSuggestionRange(
          suggestion,
          resolved.text,
          resolved.start,
          resolved.start + suggestion.originalText.length,
        );
      }, { socket, historyReason: 'suggestion-revert', actor });
      this.stateBudgetBytes = projectedBytes;
      this.schedulePersist();
      this.broadcastReview();
      return;
    }

    if (message.type === 'personal-projection-get') {
      const requestId = controlledString(message.requestId, 'Projection request id', 128, { required: true });
      const actor = this.actorFor(socket, message, 'Personal projection');
      const subjectAuthorId = controlledString(
        message.subjectAuthorId ?? actor.id, 'Projection author id', 256, { required: true },
      );
      const baseText = String(this.gitBase?.text ?? this.history.text(this.history.entries[0]?.id) ?? '');
      const text = this.history.personalProjection(subjectAuthorId, baseText);
      sendWithBackpressure(socket, JSON.stringify({
        type: 'personal-projection', documentId: this.documentId, requestId,
        subjectAuthorId,
        textBase64: Buffer.from(text, 'utf8').toString('base64'),
        contributors: this.history.contributors(),
        conflicts: this.history.conflicts(baseText),
      }));
      return;
    }

    if (message.type === 'history-get') {
      const id = controlledString(message.id, 'History version id', 128, { required: true });
      const text = this.history.text(id);
      if (text === null) throw new ProtocolLimitError('History version no longer exists');
      sendWithBackpressure(socket, JSON.stringify({
        type: 'history-version', documentId: this.documentId, id,
        textBase64: Buffer.from(text, 'utf8').toString('base64'),
      }));
      return;
    }

    if (message.type === 'history-restore') {
      const id = controlledString(message.id, 'History version id', 128, { required: true });
      const expectedHeadId = controlledString(message.headId, 'History head id', 128, { required: true });
      if (expectedHeadId !== this.history.headId()) {
        throw new ProtocolLimitError('Document changed after the history view was opened');
      }
      const restored = this.history.text(id);
      if (restored === null) throw new ProtocolLimitError('History version no longer exists');
      const currentText = this.document.getText('content');
      if (currentText.toString() === restored) return;
      const actor = this.actorFor(socket, message, 'History restoration');
      const candidate = new Y.Doc();
      let projectedBytes;
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
        const candidateText = candidate.getText('content');
        candidateText.delete(0, candidateText.length);
        if (restored) candidateText.insert(0, restored);
        projectedBytes = Y.encodeStateAsUpdate(candidate).byteLength;
        if (projectedBytes > MAX_ROOM_STATE_BYTES) throw new ProtocolLimitError('Restored version is too large');
        this.registry.assertStateBudget(this, projectedBytes);
      } finally {
        candidate.destroy();
      }
      this.document.transact(() => {
        currentText.delete(0, currentText.length);
        if (restored) currentText.insert(0, restored);
      }, { socket, historyReason: 'restore', actor });
      this.stateBudgetBytes = projectedBytes;
      return;
    }

    if (message.type === 'suggestion-reject') {
      const id = controlledString(message.id, 'Suggestion id', 128, { required: true });
      const suggestion = this.suggestions.find((item) => item.id === id);
      if (suggestion && suggestion.status === 'open') {
        const actor = this.actorFor(socket, message, 'Suggestion');
        suggestion.status = 'rejected';
        suggestion.decidedById = actor.id;
        suggestion.decidedBy = actor.displayName;
        this.registry.eventJournal?.append('suggestion-decision', actor, [suggestion.authorId], {
          documentId: this.documentId, suggestionId: suggestion.id, decision: 'rejected',
        });
        this.notifyTicketOwner('suggestion-rejected', actor, { suggestionId: suggestion.id });
        this.schedulePersist();
      }
      this.broadcastReview();
      return;
    }

    if (message.type === 'suggestion-delete') {
      const id = controlledString(message.id, 'Suggestion id', 128, { required: true });
      const previousLength = this.suggestions.length;
      this.suggestions = this.suggestions.filter((item) => item.id !== id);
      if (this.suggestions.length !== previousLength) this.schedulePersist();
      this.broadcastReview();
      return;
    }

    throw new Error(`Unknown server message type: ${message.type}`);
  }

  broadcastReservations() {
    this.broadcastJson({
      type: 'reservations',
      documentId: this.documentId,
      reservations: this.activeReservations(),
    });
  }

  broadcastReview() {
    this.broadcastJson({
      type: 'review',
      documentId: this.documentId,
      commentThreads: this.commentThreads,
      suggestions: this.suggestions,
    });
  }

  broadcastHistory() {
    this.broadcastJson({
      type: 'history', documentId: this.documentId,
      entries: this.history.summaries(), headId: this.history.headId(),
    });
  }

  anonymiseUser(userId) {
    let changed = false;
    for (const reservation of this.reservations) {
      if (reservation.assigneeId === userId) {
        reservation.assigneeId = null;
        reservation.assignee = 'Deleted user';
        reservation.color = '#8a8a8a';
        changed = true;
      }
      if (reservation.createdById === userId) {
        reservation.createdById = null;
        reservation.createdBy = 'Deleted user';
        changed = true;
      }
    }
    const anonymiseDiscussion = (item) => {
      if (item.authorId === userId) {
        item.authorId = null;
        item.author = 'Deleted user';
        item.color = '#8a8a8a';
        changed = true;
      }
      for (const message of item.messages ?? []) {
        if (message.authorId !== userId) continue;
        message.authorId = null;
        message.author = 'Deleted user';
        message.color = '#8a8a8a';
        changed = true;
      }
      if (item.decidedById === userId) {
        item.decidedById = null;
        item.decidedBy = 'Deleted user';
        changed = true;
      }
    };
    for (const thread of this.commentThreads) anonymiseDiscussion(thread);
    for (const suggestion of this.suggestions) anonymiseDiscussion(suggestion);
    if (this.history.anonymise(userId)) changed = true;
    if (changed) {
      this.schedulePersist();
      this.broadcastReservations();
      this.broadcastReview();
    }
  }

  broadcastJson(message, excludedSocket = null) {
    const encoded = JSON.stringify(message);
    for (const client of this.clients) {
      if (client !== excludedSocket && client.readyState === WebSocket.OPEN) {
        sendWithBackpressure(client, encoded);
      }
    }
  }

  schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist().catch(() => console.error('[server] document persistence failed'));
    }, 200);
  }

  async persist() {
    const update = Buffer.from(Y.encodeStateAsUpdate(this.document));
    const persistedRevision = this.revision;
    if (update.length > MAX_ROOM_STATE_BYTES) {
      throw new ProtocolLimitError('Document state exceeds the persistence limit');
    }
    const metadata = JSON.stringify({
      schema: 3,
      reservations: this.reservations,
      commentThreads: this.commentThreads,
      suggestions: this.suggestions,
      gitBase: this.gitBase,
    }, null, 2);
    const history = this.history.serialise();
    if (byteLength(metadata) > MAX_ROOM_METADATA_BYTES) {
      throw new ProtocolLimitError('Room metadata exceeds the persistence limit');
    }
    const write = this.persistPromise
      .catch(() => {})
      .then(() => this.registry.persistRoom(this, update, metadata, history));
    this.persistPromise = write;
    await write;
    if (this.revision === persistedRevision) this.stateBudgetBytes = update.length;
  }

  async flush() {
    await this.messageQueue;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      await this.persist();
    }
    await this.persistPromise;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.persistTimer = null;
    this.presenceTimer = null;
    this.presences.clear();
    this.presenceLastSeen.clear();
    this.presenceOwners.clear();
    this.document.destroy();
  }
}
