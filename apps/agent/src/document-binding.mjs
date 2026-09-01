import { Buffer } from 'node:buffer';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { LocalPresenceMux } from './local-presence.mjs';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '../../../packages/shared/src/constants.mjs';
import {
  utf8ByteOffsetToUtf16Index,
} from '../../../packages/shared/src/text.mjs';
import { validateServerMessage } from '../../../packages/shared/src/protocol-schema.mjs';
import * as actions from './document-actions.mjs';
import * as disk from './disk-reconciliation.mjs';
import * as view from './document-view.mjs';
import * as gitState from './git-document-state.mjs';
import * as personalDocument from './personal-document.mjs';
import { closeDocument } from './document-lifecycle.mjs';
const REMOTE_ORIGIN = Symbol('remote-server-update');
function encodeRelativePosition(position) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}
export class DocumentBinding {
  constructor(hub, documentId, relativePath, ticketId = '') {
    this.hub = hub;
    this.documentId = documentId;
    this.relativePath = relativePath;
    this.ticketId = ticketId;
    this.document = new Y.Doc();
    this.text = this.document.getText('content');
    this.clients = new Set();
    this.undoManagers = new Map();
    this.reservations = new Map();
    this.commentThreads = new Map();
    this.suggestions = new Map();
    this.history = [];
    this.historyHeadId = '';
    this.presences = new Map();
    this.localPresences = new LocalPresenceMux(this);
    this.socket = null;
    this.synced = false;
    this.canSeed = false;
    this.gitWritable = true;
    this.gitState = null;
    this.closing = false;
    this.paused = false;
    this.reconnectTimer = null;
    this.refreshScheduled = false;
    this.baseWrites = new Set();
    this.personalRequestId = '';
    this.personalRefreshPending = false;
    this.variantRequests = new Map();
    this.personalText = '';
    this.personalReady = Boolean(this.ticketId);
    this.personalContributors = [];
    this.personalConflicts = [];
    this.personalMaterialisationMode = this.ticketId ? 'mine' : this.hub.loadPersonalMode(this.relativePath);

    this.document.on('update', (update, origin) => {
      if (origin !== REMOTE_ORIGIN && this.synced && this.gitWritable
        && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(update);
      }
      if (this.synced) this.initialiseAttachedClients();
      this.scheduleRefresh();
    });
    this.connect();
  }

  connect() {
    if (this.paused || this.closing) return;
    const url = new URL(this.hub.options.server);
    url.searchParams.set('document', this.documentId);
    gitState.appendGitHead(this, url);
    const headers = this.hub.options.token
      ? { Authorization: `Bearer ${this.hub.options.token}` }
      : undefined;
    this.socket = new WebSocket(url, { maxPayload: MAX_MESSAGE_BYTES, headers });
    this.socket.binaryType = 'arraybuffer';
    this.socket.on('open', () => {
      console.log('[agent] document connected');
      this.emitDocumentStatus('syncing');
    });
    this.socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          Y.applyUpdate(this.document, new Uint8Array(data), REMOTE_ORIGIN);
        } else {
          this.receiveServerMessage(validateServerMessage(JSON.parse(data.toString('utf8'))));
        }
      } catch (error) {
        console.error('[agent] server message failed');
      }
    });
    this.socket.on('close', (code, reason) => {
      this.synced = false;
      console.warn('[agent] document disconnected');
      if (code === 1008) {
        this.paused = true;
        this.emitDocumentStatus('unauthorized');
        const detail = reason?.toString('utf8') || 'Authentication failed';
        for (const client of this.clients) {
          client.send({ type: 'notice', message: `Сервер отклонил авторизацию: ${detail}. Перезапустите Agent после входа.` });
        }
        return;
      }
      this.emitDocumentStatus('offline');
      if (!this.closing && !this.paused) this.scheduleReconnect();
    });
    this.socket.on('error', () => console.error('[agent] websocket error'));
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  reconnectForGitHead() {
    return gitState.reconnectForGitHead(this);
  }

  receiveServerMessage(message) {
    if (message.type === 'synced') {
      if (message.protocol !== PROTOCOL_VERSION) {
        throw new Error(`Protocol mismatch: server=${message.protocol}, agent=${PROTOCOL_VERSION}`);
      }
      gitState.applySyncedMessage(this, message);
      return;
    }
    if (message.type === 'git-status') {
      gitState.applyGitStatus(this, message);
      return;
    }
    if (message.type === 'reservations') {
      this.reservations = new Map((message.reservations ?? []).map((item) => [item.id, item]));
      this.emitReservations();
      return;
    }
    if (message.type === 'review') {
      this.commentThreads = new Map((message.commentThreads ?? []).map((item) => [item.id, item]));
      this.suggestions = new Map((message.suggestions ?? []).map((item) => [item.id, item]));
      this.emitReview();
      return;
    }
    if (message.type === 'directory') {
      this.hub.updateDirectory(message.users ?? []);
      return;
    }
    if (message.type === 'history') {
      this.history = message.entries ?? [];
      this.historyHeadId = message.headId ?? '';
      this.emitHistory();
      this.requestPersonalDocument();
      return;
    }
    if (message.type === 'history-version') {
      for (const client of this.clients) {
        if (client.kind !== 'review') continue;
        for (const [absolutePath, state] of client.documents) {
          if (state.binding === this) client.send({
            type: 'historyVersion', path: absolutePath, id: message.id, textBase64: message.textBase64,
          });
        }
      }
      return;
    }
    if (message.type === 'personal-projection') {
      personalDocument.handlePersonalDocument(this, message);
      return;
    }
    if (message.type === 'presence') {
      if (message.clientId && !this.hub.isLocalPresenceId(message.clientId)) {
        this.presences.set(message.clientId, message);
        this.emitPresences();
        this.emitReservationTargets();
      }
      return;
    }
    if (message.type === 'presence-left') {
      if (message.clientId) this.presences.delete(message.clientId);
      this.emitPresences();
      this.emitReservationTargets();
      return;
    }
    if (message.type === 'error') {
      console.error('[agent] server rejected an operation');
      for (const client of this.clients) {
        for (const [absolutePath, state] of client.documents) {
          if (state.binding === this) client.send({ type: 'error', path: absolutePath, message: message.message });
        }
      }
    }
  }

  attach(client, absolutePath, initialText) {
    const existing = client.documents.get(absolutePath);
    if (existing?.binding === this) {
      client.send({
        type: 'documentStatus',
        path: absolutePath,
        status: this.synced ? gitState.documentStatus(this.gitState) : 'connecting',
      });
      if (existing.initialised && this.gitWritable) {
        this.syncClientView(client, absolutePath);
        this.emitReservations(client);
        this.emitReview(client);
        this.emitHistory(client);
        this.emitPresences(client);
        this.emitReservationTargets(client);
        this.sendDocumentReady(client, absolutePath);
      }
      return;
    }
    this.clients.add(client);
    const storedBase = this.ticketId ? null : this.hub.loadBaseSnapshot(this.relativePath);
    const state = {
      binding: this,
      path: absolutePath,
      mirror: initialText,
      initialised: false,
      initialReconciled: false,
      origin: { clientId: client.clientId },
      diskBase: storedBase?.text ?? initialText,
      hasPersistedBase: storedBase != null,
      basePersistPromise: Promise.resolve(),
      diskWatcher: null,
      diskPollTimer: null,
      diskDebounce: null,
      diskCheckPromise: Promise.resolve(),
      pendingExternal: null,
      materialisationExpected: null,
      materialisationDeadline: 0,
      materialisationMismatch: null,
      pendingCursor: null,
    };
    client.documents.set(absolutePath, state);
    if (!this.ticketId) this.startFileWatcher(client, absolutePath, state);
    client.send({
      type: 'documentStatus',
      path: absolutePath,
      status: this.synced ? gitState.documentStatus(this.gitState) : 'connecting',
    });
    if (this.synced && this.gitWritable) this.initialiseClient(client, absolutePath);
  }

  initialiseAttachedClients() {
    if (!this.gitWritable) return;
    for (const client of this.clients) {
      for (const [absolutePath, state] of client.documents) {
        if (state.binding === this) this.initialiseClient(client, absolutePath);
      }
    }
  }

  initialiseClient(client, absolutePath) {
    if (!this.gitWritable) return;
    const state = client.documents.get(absolutePath);
    if (!state || state.binding !== this || state.initialised) return;
    if (!this.ticketId && client.kind !== 'review' && !this.personalReady) return;
    if (this.text.length === 0 && state.mirror.length > 0) {
      if (!this.canSeed) return;
      this.document.transact(() => this.text.insert(0, state.mirror), state.origin);
    }
    state.initialised = true;
    if (!this.undoManagers.has(client.clientId)) {
      this.undoManagers.set(client.clientId, new Y.UndoManager(this.text, {
        trackedOrigins: new Set([state.origin]),
        captureTimeout: 500,
      }));
    }
    if (this.ticketId) state.initialReconciled = true;
    else this.reconcileInitialDisk(client, absolutePath, state);
    this.syncClientView(client, absolutePath);
    this.emitReservations(client);
    this.emitReview(client);
    this.emitHistory(client);
    this.emitPresences(client);
    this.emitReservationTargets(client);
    this.sendDocumentReady(client, absolutePath);
    if (state.pendingCursor && client.activeDocumentPath === absolutePath) {
      this.cursor(client, absolutePath, state.pendingCursor);
    }
    console.log('[agent] document ready');
  }

  sendDocumentReady(client, absolutePath) {
    client.send({
      type: 'documentReady',
      path: absolutePath,
      documentId: this.documentId,
      workspace: this.hub.options.workspace,
    });
  }

  deactivatePresence(client) {
    this.localPresences.remove(client);
  }

  detachPath(client, absolutePath) {
    const state = client.documents.get(absolutePath);
    if (!state || state.binding !== this) return;
    if (state.diskDebounce) clearTimeout(state.diskDebounce);
    if (state.diskPollTimer) clearInterval(state.diskPollTimer);
    state.diskWatcher?.close();
    client.documents.delete(absolutePath);
    const stillAttached = [...client.documents.values()].some((candidate) => candidate.binding === this);
    if (stillAttached) return;
    this.clients.delete(client);
    const undo = this.undoManagers.get(client.clientId);
    if (undo) undo.destroy();
    this.undoManagers.delete(client.clientId);
  }

  detach(client) {
    this.deactivatePresence(client);
    for (const [absolutePath, state] of [...client.documents]) {
      if (state.binding === this) this.detachPath(client, absolutePath);
    }
  }

  startFileWatcher(client, absolutePath, state) {
    return disk.startFileWatcher(this, client, absolutePath, state);
  }

  scheduleDiskCheck(client, absolutePath, state, delay = 200) {
    return disk.scheduleDiskCheck(this, client, absolutePath, state, delay);
  }

  readDiskText(absolutePath) {
    return disk.readDiskText(this, absolutePath);
  }

  checkDiskChange(client, absolutePath, state) {
    return disk.checkDiskChange(this, client, absolutePath, state);
  }

  persistBaseSnapshot(state, text) {
    return disk.persistBaseSnapshot(this, state, text);
  }

  reconcileInitialDisk(client, absolutePath, state) {
    return disk.reconcileInitialDisk(this, client, absolutePath, state);
  }

  emitExternalConflicts(client, absolutePath, state, knownConflicts = null) {
    return disk.emitExternalConflicts(this, client, absolutePath, state, knownConflicts);
  }

  applyMergedText(nextText) {
    return disk.applyMergedText(this, nextText);
  }

  finishExternalMerge(client, absolutePath, state, mergedText, notice) {
    return disk.finishExternalMerge(this, client, absolutePath, state, mergedText, notice);
  }

  resolveExternalConflict(client, absolutePath, message) {
    if (message.source === 'disk') {
      return disk.resolveExternalConflict(this, client, absolutePath, message);
    }
    if (message.source === 'canonical') {
      return gitState.resolveCanonicalConflict(this, message);
    }
    const state = client.documents.get(absolutePath);
    return (state?.pendingExternal
      && disk.resolveExternalConflict(this, client, absolutePath, message))
      || gitState.resolveCanonicalConflict(this, message);
  }

  pauseForWorkspaceChange(previousWorkspace, nextWorkspace) {
    if (this.paused) return;
    this.paused = true;
    this.synced = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    for (const client of this.clients) {
      client.send({
        type: 'workspaceChanged',
        previousWorkspace,
        workspace: nextWorkspace,
        message: `Git-ветка изменилась: ${previousWorkspace} → ${nextWorkspace}. Перезапустите Desktop Agent.`,
      });
    }
    this.emitDocumentStatus('branch-changed');
  }

  edit(client, absolutePath, message) {
    return personalDocument.edit(this, client, absolutePath, message);
  }

  snapshot(client, absolutePath, message) {
    return personalDocument.snapshot(this, client, absolutePath, message);
  }

  undo(client) {
    this.undoManagers.get(client.clientId)?.undo();
  }

  redo(client) {
    this.undoManagers.get(client.clientId)?.redo();
  }

  requestPersonalDocument() { return personalDocument.requestPersonalDocument(this); }

  requestDocumentVariant(client, absolutePath, authorId) {
    return personalDocument.requestDocumentVariant(this, client, absolutePath, authorId);
  }

  localFileText() {
    return personalDocument.localFileText(this);
  }

  setPersonalMaterialisation(mode, absolutePath) {
    return personalDocument.setPersonalMaterialisation(this, mode, absolutePath);
  }

  cursor(client, absolutePath, message) {
    const state = this.requireState(client, absolutePath);
    const pendingCursor = {
      positionByte: Number(message.positionByte),
      anchorByte: Number(message.anchorByte ?? message.positionByte),
    };
    let caret;
    let anchor;
    try {
      caret = utf8ByteOffsetToUtf16Index(state.mirror, pendingCursor.positionByte);
      anchor = utf8ByteOffsetToUtf16Index(state.mirror, pendingCursor.anchorByte);
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
    state.pendingCursor = pendingCursor;
    if (!state.initialised) return true;
    const payload = {
      type: 'presence',
      clientId: this.hub.presenceClientId,
      user: this.hub.options.user,
      color: this.hub.options.color,
      caretRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, caret)),
      anchorRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, anchor)),
    };
    this.localPresences.update(client, payload);
    return true;
  }

  createReservation(client, absolutePath, message) {
    return actions.createReservation(this, client, absolutePath, message);
  }

  deleteReservationAt(client, absolutePath, message) {
    return actions.deleteReservationAt(this, client, absolutePath, message);
  }

  deleteReservation(client, absolutePath, message) {
    return actions.deleteReservation(this, client, absolutePath, message);
  }

  createComment(client, absolutePath, message) {
    return actions.createComment(this, client, absolutePath, message);
  }

  replyToDiscussion(client, absolutePath, message, targetType) {
    return actions.replyToDiscussion(this, client, absolutePath, message, targetType);
  }

  setCommentStatus(client, absolutePath, message) {
    return actions.setCommentStatus(this, client, absolutePath, message);
  }

  deleteReviewItem(client, absolutePath, message, targetType) {
    return actions.deleteReviewItem(this, client, absolutePath, message, targetType);
  }

  createSuggestion(client, absolutePath, message) {
    return actions.createSuggestion(this, client, absolutePath, message);
  }

  updateSuggestion(client, absolutePath, message) {
    return actions.updateSuggestion(this, client, absolutePath, message);
  }

  decideSuggestion(client, absolutePath, message, decision) {
    return actions.decideSuggestion(this, client, absolutePath, message, decision);
  }

  requireState(client, absolutePath) {
    const state = client.documents.get(absolutePath);
    if (!state || state.binding !== this) throw new Error('Document is not attached to this plugin client');
    return state;
  }

  scheduleRefresh() { return view.scheduleRefresh(this); }
  emitDocumentStatus(status) {
    return view.emitDocumentStatus(this, status);
  }

  refreshAllViews() { return view.refreshAllViews(this); }
  syncClientView(client, absolutePath) { return view.syncClientView(this, client, absolutePath); }

  resolveReservation(reservation) {
    return view.resolveReservation(this, reservation);
  }

  resolveAnchoredItem(item) {
    return view.resolveAnchoredItem(this, item);
  }

  discussionText(item) {
    return view.discussionText(this, item);
  }

  emitReview(onlyClient = null) {
    return view.emitReview(this, onlyClient);
  }

  emitReservations(onlyClient = null) {
    return view.emitReservations(this, onlyClient);
  }

  emitPresences(onlyClient = null) {
    return view.emitPresences(this, onlyClient);
  }

  emitHistory(onlyClient = null) {
    return view.emitHistory(this, onlyClient);
  }

  emitReservationTargets(onlyClient = null) {
    return view.emitReservationTargets(this, onlyClient);
  }

  async close() { return closeDocument(this); }
}
