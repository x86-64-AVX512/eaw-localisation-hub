import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import {
  DISPLAY_VERSION,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from '../../../packages/shared/src/constants.mjs';
import { normaliseTrackedPath, withoutUtf8Bom } from '../../../packages/shared/src/text.mjs';
import { validatePluginMessage } from '../../../packages/shared/src/protocol-schema.mjs';
import { DocumentBinding } from './document-binding.mjs';
import * as ticketContext from './git-ticket-context.mjs';
import { TicketWorkflow } from './ticket-workflow.mjs';
import { KeyReplacementWorkflow } from './key-replacement-workflow.mjs';
import { serverHttpUrl } from './server-http-url.mjs';
import { transitionWorkspace } from './workspace-transition.mjs';
import { runGitSync } from './git-executable.mjs';

function sendLine(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function ipcProof(secret, role, nonce) {
  return crypto.createHmac('sha256', secret).update(`${role}:${nonce}`, 'utf8').digest('hex');
}

function validIpcProof(actual, expected) {
  const actualBytes = Buffer.from(String(actual ?? ''), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function gitPath(repository, relative) {
  const result = runGitSync(['rev-parse', '--git-path', relative], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
  });
  return result.status === 0 && result.stdout.trim()
    ? path.resolve(repository, result.stdout.trim()) : '';
}

function removeLegacyCommitGuard(repository) {
  const hook = gitPath(repository, 'hooks/pre-commit');
  if (!hook) return;
  let owned = false;
  try {
    owned = fs.readFileSync(hook, 'utf8').includes('EaW Localisation Hub mixed-author guard');
  } catch {}
  if (!owned) return;
  const backup = gitPath(repository, 'hooks/pre-commit.eaw-hub-original');
  try {
    fs.unlinkSync(hook);
    if (backup && fs.existsSync(backup)) fs.renameSync(backup, hook);
    const stateDirectory = gitPath(repository, 'eaw-hub');
    for (const name of ['mixed-files.txt', 'allow-mixed-once']) {
      const target = stateDirectory ? path.join(stateDirectory, name) : '';
      if (target && fs.existsSync(target)) fs.unlinkSync(target);
    }
    console.log('[agent] removed obsolete mixed-author commit guard');
  } catch {
    console.warn('[agent] could not remove obsolete mixed-author commit guard');
  }
}

class PluginClient {
  constructor(socket, hub) {
    this.socket = socket;
    this.hub = hub;
    this.clientId = `plugin-${process.pid}-${crypto.randomUUID()}`;
    this.kind = 'plugin';
    this.documents = new Map();
    this.ignoredDocuments = new Set();
    this.activeDocumentPath = null;
    this.buffer = '';
    this.closed = false;
    this.authenticated = false;
    this.challenge = crypto.randomBytes(32).toString('hex');
    this.handshakeTimer = setTimeout(() => this.socket.destroy(), 5000);
    this.handshakeTimer.unref();
    this.bindSocket();
  }

  bindSocket() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        this.fail(new Error('IPC message buffer exceeded the prototype limit'));
        return;
      }
      while (true) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.hub.receivePluginMessage(this, validatePluginMessage(JSON.parse(line)));
        } catch (error) {
          this.fail(error);
        }
      }
    });
    this.socket.on('error', () => console.error('[agent] plugin socket error'));
    this.socket.on('close', () => this.close());
    this.send({
      type: 'ipcChallenge',
      protocol: PROTOCOL_VERSION,
      nonce: this.challenge,
      agentProof: ipcProof(this.hub.options.ipcSecret, 'agent', this.challenge),
    });
  }

  send(message) {
    sendLine(this.socket, message);
  }

  fail(error) {
    console.error('[agent] plugin message failed');
    this.send({ type: 'error', message: error.message });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    this.hub.detachClient(this);
  }
}

export class AgentHub {
  constructor(options) {
    this.options = options;
    this.clients = new Set();
    this.clientsById = new Map();
    this.presenceClientId = `agent-presence-${process.pid}-${crypto.randomUUID()}`;
    this.documents = new Map();
    this.identity = null;
    this.directory = [];
    this.ticketWorkflow = new TicketWorkflow(this);
    this.keyReplacementWorkflow = new KeyReplacementWorkflow(this);
    this.workspaceBlocked = false;
    this.workspaceTransitioning = false;
    this.workspaceTransitionPromise = null;
    this.detectedWorkspace = options.workspace;
    this.workspaceObservationCount = 0;
    this.branchWatcher = null;
    this.branchDebounce = null;
    this.gitIndexPath = '';
    this.gitIndexLock = '';
    this.accountRefreshTimer = setInterval(() => {
      this.refreshAccountStatus().catch(() => {});
    }, 15_000);
    this.accountRefreshTimer.unref();
    this.gitCommit = this.currentDocumentGitCommit();
    this.gitCommitTimer = setInterval(() => this.checkGitCommitChange(), 1_000);
    this.gitCommitTimer.unref();
    removeLegacyCommitGuard(this.options.repo);
    this.startBranchWatcher();
    this.refreshAccountStatus().catch(() => {});
  }

  updateIdentity(identity) {
    const displayName = String(identity?.displayName ?? '').trim();
    if (!displayName) return;
    this.identity = {
      id: String(identity.id ?? ''),
      displayName,
      roles: Array.isArray(identity.roles) ? [...identity.roles] : [],
      avatarBase64: String(identity.avatarBase64 ?? ''),
      temporaryPassword: identity.temporaryPassword === true,
      // An empty value means that the server has not confirmed the account state yet.
      // Never turn a delayed/failed /api/auth/me request into a false recovery warning.
      recoveryStatus: String(identity.recoveryStatus ?? ''),
    };
    this.options.user = displayName;
    for (const client of this.clients) {
      if (client.authenticated) this.sendAgentHello(client);
    }
  }

  isLocalPresenceId(clientId) {
    return clientId === this.presenceClientId || this.clientsById.has(clientId);
  }

  sendAgentHello(client) {
    client.send({
      type: 'agentHello',
      version: DISPLAY_VERSION,
      protocol: PROTOCOL_VERSION,
      user: this.options.user,
      color: this.options.color,
      workspace: this.options.workspace,
      roles: this.identity?.roles ?? [],
      userId: this.identity?.id ?? '',
      avatarBase64: this.identity?.avatarBase64 ?? '',
      temporaryPassword: this.identity?.temporaryPassword === true,
      recoveryStatus: this.identity?.recoveryStatus ?? '',
    });
  }

  updateDirectory(users) {
    this.directory = (Array.isArray(users) ? users : []).map((user) => ({
      id: String(user.id ?? ''),
      displayName: String(user.displayName ?? '').trim(),
      color: String(user.color ?? '#6aa9ff'),
      avatarBase64: String(user.avatarBase64 ?? ''),
    })).filter((user) => user.displayName);
    const self = this.directory.find((user) => user.id === this.identity?.id);
    if (self) this.identity.avatarBase64 = self.avatarBase64;
    for (const binding of this.documents.values()) {
      binding.emitReservationTargets();
      binding.emitReview();
      binding.emitPresences();
    }
  }

  baseSnapshotPath(relativePath) {
    const normaliseIdentity = (value) => process.platform === 'win32'
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
    const repositoryHash = crypto
      .createHash('sha256')
      .update(normaliseIdentity(this.options.repo))
      .digest('hex')
      .slice(0, 20);
    const workspaceHash = crypto
      .createHash('sha256')
      .update(this.options.workspace)
      .digest('hex')
      .slice(0, 16);
    const fileHash = crypto
      .createHash('sha256')
      .update(relativePath)
      .digest('hex');
    return path.join(this.options.state, 'merge-bases', repositoryHash, workspaceHash, `${fileHash}.json`);
  }

  personalModePath(relativePath) {
    return this.baseSnapshotPath(relativePath)
      .replace(`${path.sep}merge-bases${path.sep}`, `${path.sep}personal-modes${path.sep}`);
  }

  loadPersonalMode(relativePath) {
    try {
      const value = JSON.parse(fs.readFileSync(this.personalModePath(relativePath), 'utf8'));
      return value.relativePath === relativePath && value.mode === 'git' ? 'git' : 'mine';
    } catch {
      return 'mine';
    }
  }

  async savePersonalMode(relativePath, mode) {
    const target = this.personalModePath(relativePath);
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, `${JSON.stringify({ schema: 1, relativePath, mode })}\n`, 'utf8');
  }


  loadBaseSnapshot(relativePath) {
    const snapshotPath = this.baseSnapshotPath(relativePath);
    try {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      if (snapshot.schema !== 1 || snapshot.relativePath !== relativePath) return null;
      return {
        text: Buffer.from(String(snapshot.textBase64 ?? ''), 'base64').toString('utf8'),
        savedAt: snapshot.savedAt,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[agent] invalid merge base ignored');
      }
      return null;
    }
  }

  async saveBaseSnapshot(relativePath, text) {
    const snapshotPath = this.baseSnapshotPath(relativePath);
    await fsPromises.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fsPromises.writeFile(snapshotPath, `${JSON.stringify({
      schema: 1,
      repository: this.options.repo,
      workspace: this.options.workspace,
      relativePath,
      savedAt: new Date().toISOString(),
      textBase64: Buffer.from(text, 'utf8').toString('base64'),
    })}\n`, 'utf8');
  }

  startBranchWatcher() {
    if (this.options.workspaceExplicit) return;
    const gitPath = runGitSync(['rev-parse', '--git-path', 'HEAD'], {
      cwd: this.options.repo,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (gitPath.status !== 0 || !gitPath.stdout.trim()) return;
    const headPath = path.resolve(this.options.repo, gitPath.stdout.trim());
    const indexLock = runGitSync(['rev-parse', '--git-path', 'index.lock'], {
      cwd: this.options.repo, encoding: 'utf8', windowsHide: true,
    });
    this.gitIndexLock = indexLock.status === 0 && indexLock.stdout.trim()
      ? path.resolve(this.options.repo, indexLock.stdout.trim()) : '';
    const indexPath = runGitSync(['rev-parse', '--git-path', 'index'], {
      cwd: this.options.repo, encoding: 'utf8', windowsHide: true,
    });
    this.gitIndexPath = indexPath.status === 0 && indexPath.stdout.trim()
      ? path.resolve(this.options.repo, indexPath.stdout.trim()) : '';
    try {
      this.branchWatcher = fs.watch(path.dirname(headPath), { persistent: false }, (_event, filename) => {
        if (filename && String(filename).toLowerCase() !== path.basename(headPath).toLowerCase()) return;
        if (this.branchDebounce) clearTimeout(this.branchDebounce);
        this.branchDebounce = setTimeout(() => {
          this.branchDebounce = null;
          this.checkWorkspaceChange();
        }, 200);
      });
      this.branchWatcher.on('error', (error) => {
        console.error('[agent] Git branch watcher failed');
      });
    } catch (error) {
      console.error('[agent] could not watch Git branch');
    }
  }

  currentGitWorkspace() {
    const branch = runGitSync(['branch', '--show-current'], {
      cwd: this.options.repo,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (branch.status === 0 && branch.stdout.trim()) return branch.stdout.trim();
    return '';
  }

  currentGitCommit() {
    return ticketContext.currentGitCommit(this.options.repo);
  }

  readGitHeadText(relativePath) {
    const shown = runGitSync(['show', `HEAD:${relativePath}`], {
      cwd: this.options.repo,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (shown.status !== 0) throw new Error('Файл отсутствует в текущей Git-версии (HEAD).');
    return withoutUtf8Bom(shown.stdout);
  }


  currentDocumentGitCommit() {
    try {
      return this.currentGitCommit();
    } catch {
      return '';
    }
  }

  gitCheckoutObservation() {
    let indexFingerprint = 'missing';
    try {
      const stat = fs.statSync(this.gitIndexPath);
      indexFingerprint = `${stat.size}:${stat.mtimeMs}`;
    } catch {}
    return {
      workspace: this.currentGitWorkspace(),
      commit: this.currentDocumentGitCommit(),
      locked: Boolean(this.gitIndexLock && fs.existsSync(this.gitIndexLock)),
      indexFingerprint,
    };
  }

  checkGitCommitChange() {
    if (this.workspaceTransitioning) return;
    if (!this.options.workspaceExplicit) {
      const workspace = this.currentGitWorkspace();
      if (!workspace) return;
      if (workspace !== this.options.workspace) {
        this.checkWorkspaceChange(workspace);
        return;
      }
    }
    const commit = this.currentDocumentGitCommit();
    if (!commit) return;
    if (commit === this.gitCommit) return;
    this.gitCommit = commit;
    for (const binding of this.documents.values()) binding.reconnectForGitHead();
  }

  async ticketRequest(route, options = {}) {
    return this.authRequest(route, options);
  }

  async assertCanonicalGitHead() {
    const branch = encodeURIComponent(this.options.workspace);
    const canonical = await this.authRequest(`/api/git/head?branch=${branch}`, { method: 'GET' });
    if (canonical.disabled) return canonical;
    const local = this.currentGitCommit();
    if (canonical.commit !== local) {
      throw new Error('Локальная Git-ветка устарела. Сначала обновите её через GitHub Desktop.');
    }
    return canonical;
  }

  async ticketBootstrap(ticketId, relativePath) {
    return ticketContext.ticketBootstrap(this, ticketId, relativePath);
  }

  async englishOriginal(key, ticketId = '') {
    return ticketContext.englishOriginal(this, key, ticketId);
  }

  gitOperationInProgress() {
    return this.workspaceTransitioning || Boolean(this.gitIndexLock && fs.existsSync(this.gitIndexLock));
  }

  checkWorkspaceChange(observedWorkspace = '') {
    if (this.options.workspaceExplicit || this.workspaceTransitioning) return;
    const workspace = observedWorkspace || this.currentGitWorkspace();
    if (!workspace || workspace === this.options.workspace) {
      this.detectedWorkspace = this.options.workspace;
      this.workspaceObservationCount = 0;
      return;
    }
    if (workspace !== this.detectedWorkspace) {
      this.detectedWorkspace = workspace;
      this.workspaceObservationCount = 1;
      return;
    }
    this.workspaceObservationCount += 1;
    if (this.workspaceObservationCount < 2) return;
    this.workspaceObservationCount = 0;
    this.workspaceTransitioning = true;
    this.detectedWorkspace = workspace;
    console.warn('[agent] Git workspace changed; rebinding documents');
    this.workspaceTransitionPromise = transitionWorkspace(this, workspace)
      .catch((error) => {
        console.error('[agent] Git workspace transition failed');
        for (const client of this.clients) client.send({
          type: 'error', code: 'branch-switch-failed',
          message: `Не удалось переключить совместные документы на ветку ${workspace}: ${error.message}`,
        });
      })
      .finally(() => {
        this.workspaceTransitioning = false;
        this.workspaceTransitionPromise = null;
      });
  }

  receivePluginMessage(client, message) {
    if (!client.authenticated) {
      if (message.type !== 'hello'
        || Number(message.protocol) !== PROTOCOL_VERSION
        || !validIpcProof(
          message.proof,
          ipcProof(this.options.ipcSecret, 'plugin', client.challenge),
        )) {
        client.socket.destroy();
        return;
      }
      client.authenticated = true;
      clearTimeout(client.handshakeTimer);
      if (message.clientId) {
        this.clientsById.delete(client.clientId);
        client.clientId = String(message.clientId).slice(0, 128);
        this.clientsById.set(client.clientId, client);
      }
      this.sendAgentHello(client);
      return;
    }
    if (message.type === 'hello') return;
    if (message.type === 'recoveryIssue') {
      this.issueRecoveryCode(client).catch(() => client.send({
        type: 'error', message: 'Не удалось выпустить код восстановления.',
      }));
      return;
    }
    if (message.type === 'recoveryConfirm') {
      this.confirmRecoveryCode(client, message.recoveryCode).catch(() => client.send({
        type: 'error', message: 'Не удалось подтвердить сохранение кода восстановления.',
      }));
      return;
    }
    if (message.type === 'recoveryDiscard') {
      this.discardRecoveryCode(client).catch(() => client.send({
        type: 'error', message: 'Не удалось аннулировать несохранённый код.',
      }));
      return;
    }
    if (this.workspaceTransitioning) {
      this.workspaceTransitionPromise?.then(() => {
        if (!client.closed) this.receivePluginMessage(client, message);
      });
      return;
    }
    if (message.type === 'open') {
      const absolutePath = path.resolve(String(message.path));
      let relativePath;
      try {
        relativePath = normaliseTrackedPath(this.options.repo, absolutePath);
      } catch {
        client.ignoredDocuments ??= new Set();
        client.ignoredDocuments.add(absolutePath);
        return;
      }
      client.ignoredDocuments?.delete(absolutePath);
      client.workspaceUnavailableDocuments?.delete(absolutePath);
      const ticketId = String(message.ticketId ?? '');
      if (ticketId && !/^[0-9a-f-]{36}$/u.test(ticketId)) throw new Error('Invalid ticket id');
      const namespace = ticketId ? `ticket-${ticketId}` : this.options.workspace;
      const documentId = `${namespace}:${relativePath}`;
      let binding = this.documents.get(documentId);
      if (!binding) {
        binding = new DocumentBinding(this, documentId, relativePath, ticketId);
        this.documents.set(documentId, binding);
      }
      const initialText = Buffer.from(message.textBase64 ?? '', 'base64').toString('utf8');
      binding.attach(client, absolutePath, initialText);
      return;
    }

    const absolutePath = path.resolve(String(message.path ?? ''));
    if (message.type === 'reviewOpen') {
      normaliseTrackedPath(this.options.repo, absolutePath);
      Promise.resolve(this.options.reviewOpen?.(absolutePath)).catch((error) => client.send({
        type: 'error', code: 'review-open-failed',
        message: `Не удалось открыть Review: ${error.message}`,
      }));
      return;
    }
    const state = client.documents.get(absolutePath);
    if (!state && message.type === 'close') {
      client.workspaceUnavailableDocuments?.delete(absolutePath);
    }
    if (!state && client.ignoredDocuments?.has(absolutePath)) {
      if (message.type === 'activate') {
        if (client.activeDocumentPath && client.activeDocumentPath !== absolutePath) {
          client.documents.get(client.activeDocumentPath)?.binding.deactivatePresence(client);
        }
        client.activeDocumentPath = absolutePath;
      } else if (message.type === 'deactivate' && client.activeDocumentPath === absolutePath) {
        client.activeDocumentPath = null;
      } else if (message.type === 'close') {
        if (client.activeDocumentPath === absolutePath) client.activeDocumentPath = null;
        client.ignoredDocuments.delete(absolutePath);
      }
      return;
    }
    if (!state && ['activate', 'deactivate', 'cursor', 'close', 'edit', 'snapshot'].includes(message.type)) return;
    if (!state) throw new Error(`The plugin has not opened ${absolutePath}`);
    const gitMutations = new Set([
      'edit', 'snapshot', 'undo', 'redo', 'reservationCreate', 'reservationDeleteAt',
      'reservationDelete', 'commentCreate', 'commentReply', 'commentStatus', 'commentDelete',
      'suggestionCreate', 'suggestionUpdate', 'suggestionReply', 'suggestionAccept',
      'suggestionRevert', 'suggestionReject', 'suggestionDelete', 'historyRestore',
      'externalConflictResolve', 'personalFileMaterialize',
      'documentVariantRequest',
    ]);
    if (!state.binding.gitWritable && gitMutations.has(message.type)
      && !(message.type === 'externalConflictResolve' && state.binding.gitState?.status === 'conflict')) {
      client.send({
        type: 'notice',
        message: 'Git-версия этого файла устарела. Обновите репозиторий через GitHub Desktop; документ открыт только для чтения.',
      });
      return;
    }
    if (message.type === 'activate') {
      if (client.activeDocumentPath && client.activeDocumentPath !== absolutePath) {
        const previous = client.documents.get(client.activeDocumentPath);
        previous?.binding.deactivatePresence(client);
      }
      client.activeDocumentPath = absolutePath;
      state.binding.cursor(client, absolutePath, message);
    } else if (message.type === 'deactivate') {
      if (client.activeDocumentPath === absolutePath) {
        state.binding.deactivatePresence(client);
        client.activeDocumentPath = null;
      }
    } else if (message.type === 'close') {
      if (client.activeDocumentPath === absolutePath) {
        state.binding.deactivatePresence(client);
        client.activeDocumentPath = null;
      }
      const binding = state.binding;
      binding.detachPath(client, absolutePath);
      if (binding.clients.size === 0) {
        this.documents.delete(binding.documentId);
        binding.close().catch(() => console.error('[agent] document close failed'));
      }
    } else if (message.type === 'edit') state.binding.edit(client, absolutePath, message);
    else if (message.type === 'snapshot') state.binding.snapshot(client, absolutePath, message);
    else if (message.type === 'cursor') {
      if (client.activeDocumentPath !== absolutePath) {
        throw new Error('Cursor update does not belong to the active document');
      }
      state.binding.cursor(client, absolutePath, message);
    }
    else if (message.type === 'undo') state.binding.undo(client);
    else if (message.type === 'redo') state.binding.redo(client);
    else if (message.type === 'reservationCreate') state.binding.createReservation(client, absolutePath, message);
    else if (message.type === 'reservationDeleteAt') state.binding.deleteReservationAt(client, absolutePath, message);
    else if (message.type === 'reservationDelete') state.binding.deleteReservation(client, absolutePath, message);
    else if (message.type === 'commentCreate') state.binding.createComment(client, absolutePath, message);
    else if (message.type === 'commentReply') state.binding.replyToDiscussion(client, absolutePath, message, 'comment');
    else if (message.type === 'commentStatus') state.binding.setCommentStatus(client, absolutePath, message);
    else if (message.type === 'commentDelete') state.binding.deleteReviewItem(client, absolutePath, message, 'comment');
    else if (message.type === 'suggestionCreate') state.binding.createSuggestion(client, absolutePath, message);
    else if (message.type === 'suggestionUpdate') state.binding.updateSuggestion(client, absolutePath, message);
    else if (message.type === 'suggestionReply') state.binding.replyToDiscussion(client, absolutePath, message, 'suggestion');
    else if (message.type === 'suggestionAccept') state.binding.decideSuggestion(client, absolutePath, message, 'accept');
    else if (message.type === 'suggestionRevert') state.binding.decideSuggestion(client, absolutePath, message, 'revert');
    else if (message.type === 'suggestionReject') state.binding.decideSuggestion(client, absolutePath, message, 'reject');
    else if (message.type === 'suggestionDelete') state.binding.deleteReviewItem(client, absolutePath, message, 'suggestion');
    else if (message.type === 'historyRequest') state.binding.socket?.send(JSON.stringify({
      type: 'history-get', id: message.id,
    }));
    else if (message.type === 'historyRestore') state.binding.socket?.send(JSON.stringify({
      type: 'history-restore', id: message.id, headId: message.headId,
      author: this.options.user, color: this.options.color,
    }));
    else if (message.type === 'personalFileMaterialize') {
      state.binding.setPersonalMaterialisation(String(message.mode), absolutePath);
    }
    else if (message.type === 'documentVariantRequest') {
      state.binding.requestDocumentVariant(client, absolutePath, String(message.authorId));
    }
    else if (message.type === 'avatarSet' || message.type === 'avatarDelete') {
      this.updateAvatar(client, message.type === 'avatarSet' ? message.avatarBase64 : '').catch(() => {
        client.send({ type: 'error', message: 'Не удалось обновить аватар.' });
      });
    }
    else if (message.type === 'externalConflictResolve') state.binding.resolveExternalConflict(client, absolutePath, message);
    else throw new Error(`Unknown plugin message type: ${message.type}`);
  }

  async updateAvatar(client, avatarBase64) {
    const payload = await this.authRequest('/api/auth/avatar', {
      method: avatarBase64 ? 'PUT' : 'DELETE',
      body: avatarBase64 ? JSON.stringify({ avatarBase64 }) : undefined,
    });
    this.updateIdentity(payload.user);
    client.send({ type: 'notice', message: avatarBase64 ? 'Аватар обновлён.' : 'Аватар удалён.' });
  }

  async authRequest(route, options = {}) {
    const endpoint = serverHttpUrl(this.options.server, route);
    const response = await fetch(endpoint, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Authentication API failed with HTTP ${response.status}`);
    return payload;
  }

  async refreshAccountStatus() {
    const payload = await this.authRequest('/api/auth/me', { method: 'GET' });
    this.updateIdentity(payload.user);
  }

  async issueRecoveryCode(client) {
    const payload = await this.authRequest('/api/auth/recovery/issue', { method: 'POST', body: '{}' });
    this.updateIdentity(payload.user);
    client.send({ type: 'recoveryCode', recoveryCode: payload.code });
  }

  async confirmRecoveryCode(client, recoveryCode) {
    const payload = await this.authRequest('/api/auth/recovery/confirm', {
      method: 'POST', body: JSON.stringify({ recoveryCode }),
    });
    this.updateIdentity(payload.user);
    client.send({ type: 'notice', message: 'Код восстановления сохранён и активирован.' });
  }

  async discardRecoveryCode(client) {
    const payload = await this.authRequest('/api/auth/recovery/discard', { method: 'POST', body: '{}' });
    this.updateIdentity(payload.user);
    client.send({ type: 'notice', message: 'Несохранённый код аннулирован. Можно выпустить новый.' });
  }

  attachSocket(socket) {
    if (this.clients.size >= 4) {
      socket.destroy();
      return;
    }
    const client = new PluginClient(socket, this);
    this.clients.add(client);
    this.clientsById.set(client.clientId, client);
    console.log('[agent] plugin connected');
  }

  attachAuthenticatedClient(client) {
    if (this.clients.size >= 8 || !client?.authenticated) return false;
    this.clients.add(client);
    this.clientsById.set(client.clientId, client);
    this.sendAgentHello(client);
    console.log('[agent] local review client connected');
    return true;
  }

  detachClient(client) {
    this.clients.delete(client);
    this.clientsById.delete(client.clientId);
    const bindings = new Set([...client.documents.values()].map((state) => state.binding));
    for (const binding of bindings) binding.detach(client);
    client.documents.clear();
    client.workspaceUnavailableDocuments?.clear();
    client.ignoredDocuments?.clear();
    client.activeDocumentPath = null;
    for (const binding of bindings) {
      if (binding.clients.size !== 0) continue;
      this.documents.delete(binding.documentId);
      binding.close().catch(() => console.error('[agent] document close failed'));
    }
    console.log('[agent] plugin disconnected');
  }

  async close() {
    clearInterval(this.accountRefreshTimer);
    clearInterval(this.gitCommitTimer);
    if (this.branchDebounce) clearTimeout(this.branchDebounce);
    this.branchWatcher?.close();
    for (const client of this.clients) client.socket.destroy();
    await Promise.all([...this.documents.values()].map((binding) => binding.close()));
  }
}
