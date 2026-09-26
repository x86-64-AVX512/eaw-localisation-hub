import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_LOADED_ROOMS,
  MAX_PERSISTED_DOCUMENT_BYTES,
  MAX_PERSISTED_ROOMS,
  MAX_TOTAL_ROOM_STATE_BYTES,
  ROOM_IDLE_MILLISECONDS,
} from '../../../packages/shared/src/constants.mts';
import { ProtocolLimitError, byteLength } from './protocol-limits.mts';

export class RoomRegistry {
  constructor(dataDirectory, authStore, loadRoom, atomicWrite, canonicalSource = null) {
    this.dataDirectory = dataDirectory;
    this.authStore = authStore;
    this.loadRoom = loadRoom;
    this.atomicWrite = atomicWrite;
    this.canonicalSource = canonicalSource;
    this.rooms = new Map();
    this.persisted = new Map();
    this.persistedTotalBytes = 0;
    this.persistencePromise = Promise.resolve();
    this.evictionTimer = null;
    this.canonicalTimer = null;
    this.persistenceGenerations = new Map();
    this.knownDocuments = new Map();
    this.indexedDocuments = new Set();
    this.indexPath = path.join(dataDirectory, 'room-index.json');
    this.branchHints = new Map();
    this.legacyDocumentsByBranch = new Map();
    this.mergedBranches = new Map();
    this.mergingBranches = new Set();
    this.branchMergeService = null;
    this.eventJournal = null;
    this.auditLog = null;
    this.ticketStore = null;
  }

  async initialise() {
    const directory = path.join(this.dataDirectory, 'documents');
    try {
      const index = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
      if (index.schema === 1 && index.documents && typeof index.documents === 'object') {
        for (const [hash, documentId] of Object.entries(index.documents)) {
          if (typeof documentId !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)
            || crypto.createHash('sha256').update(documentId).digest('hex') !== hash) continue;
          this.knownDocuments.set(hash, documentId);
          this.indexedDocuments.add(hash);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.dataDirectory, 'branch-merges.json'), 'utf8'));
      if (state.schema === 1 && state.branches && typeof state.branches === 'object') {
        this.mergedBranches = new Map(Object.entries(state.branches));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = /^([0-9a-f]{64})\.(update|json|history\.json)$/u.exec(entry.name);
      if (!match) continue;
      const stats = await fs.stat(path.join(directory, entry.name));
      this.persisted.set(match[1], (this.persisted.get(match[1]) ?? 0) + stats.size);
      this.persistedTotalBytes += stats.size;
      if (match[2] === 'json') {
        let metadata;
        try {
          metadata = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
        } catch {
          console.error(`[server] cannot index document metadata ${entry.name}`);
          continue;
        }
        const branch = String(metadata.gitBase?.branch ?? '');
        const commit = String(metadata.gitBase?.commit ?? '');
        const checkedAt = Number(metadata.gitBase?.checkedAt ?? 0);
        if (branch && /^[0-9a-f]{40}$/u.test(commit)
          && checkedAt >= (this.branchHints.get(branch)?.checkedAt ?? -1)) {
          this.branchHints.set(branch, { commit, checkedAt });
        }
        if (branch && !this.knownDocuments.has(match[1])) {
          const legacy = this.legacyDocumentsByBranch.get(branch) ?? new Set();
          legacy.add(match[1]);
          this.legacyDocumentsByBranch.set(branch, legacy);
        }
      }
    }
    if (this.persisted.size > MAX_PERSISTED_ROOMS
      || this.persistedTotalBytes > MAX_PERSISTED_DOCUMENT_BYTES) {
      throw new Error('Persisted document storage already exceeds the configured safety budget');
    }
    for (const [branch, merge] of this.mergedBranches) {
      const documents = (Array.isArray(merge.documentIds) ? merge.documentIds : [])
        .filter((id) => typeof id === 'string' && id.startsWith(`${branch}:`)
          && this.persisted.has(crypto.createHash('sha256').update(id).digest('hex')));
      if (documents.length) await this.deleteDocuments(documents, `Branch merged into ${merge.target}`);
    }
    this.evictionTimer = setInterval(() => {
      this.evictIdleRooms().catch(() => console.error('[server] idle room eviction failed'));
    }, Math.min(30_000, ROOM_IDLE_MILLISECONDS));
    this.evictionTimer.unref();
    if (this.canonicalSource?.enabled) {
      this.canonicalTimer = setInterval(() => {
        this.refreshCanonicalRooms().catch(() => console.error('[server] canonical Git refresh failed'));
      }, this.canonicalSource.refreshMilliseconds);
      this.canonicalTimer.unref();
    }
  }

  async refreshCanonicalRooms() {
    for (const value of this.rooms.values()) {
      const room = await value;
      if (room.clients.size > 0) {
        try {
          await room.refreshCanonical();
        } catch (error) {
          console.error(`[server] canonical refresh failed for ${room.documentId}: ${error.message}`);
        }
      }
    }
    await this.branchMergeService?.refresh();
  }

  isUnavailableBranch(documentId) {
    const branch = String(documentId).split(':', 1)[0];
    return this.mergingBranches.has(branch) || this.mergedBranches.has(branch);
  }

  documentIdsForBranch(branch, targetPaths = []) {
    const result = new Set([...this.knownDocuments]
      .filter(([hash, documentId]) => this.persisted.has(hash)
        && documentId.startsWith(`${branch}:`))
      .map(([, documentId]) => documentId));
    for (const relativePath of targetPaths) {
      const documentId = `${branch}:${relativePath}`;
      const hash = crypto.createHash('sha256').update(documentId).digest('hex');
      if (this.persisted.has(hash)) result.add(documentId);
    }
    for (const documentId of this.rooms.keys()) {
      if (documentId.startsWith(`${branch}:`)) result.add(documentId);
    }
    return [...result];
  }

  unresolvedLegacyHashes(branch, targetPaths) {
    const unresolved = new Set(this.legacyDocumentsByBranch.get(branch) ?? []);
    for (const relativePath of targetPaths) {
      const hash = crypto.createHash('sha256').update(`${branch}:${relativePath}`).digest('hex');
      unresolved.delete(hash);
    }
    return [...unresolved];
  }

  async markBranchMerged(branch, target, commit, documentIds = []) {
    const next = new Map(this.mergedBranches);
    next.set(branch, { target, commit, at: new Date().toISOString(), documentIds });
    await this.atomicWrite(path.join(this.dataDirectory, 'branch-merges.json'),
      `${JSON.stringify({ schema: 1, branches: Object.fromEntries(next) }, null, 2)}\n`);
    this.mergedBranches = next;
    for (const [documentId, value] of this.rooms) {
      if (!documentId.startsWith(`${branch}:`)) continue;
      const room = await value;
      for (const client of room.clients) client.close(4002, `Branch merged into ${target}`);
    }
  }

  async persistDocumentIndex() {
    const documents = Object.fromEntries([...this.knownDocuments]
      .filter(([hash]) => this.persisted.has(hash)));
    await this.atomicWrite(this.indexPath, `${JSON.stringify({ schema: 1, documents }, null, 2)}\n`);
    this.indexedDocuments = new Set(Object.keys(documents));
  }

  persistedBytesFor(hash) {
    return this.persisted.get(hash) ?? 0;
  }

  loadedStateBytes() {
    let total = 0;
    for (const value of this.rooms.values()) {
      if (Number.isFinite(value?.stateBudgetBytes)) total += value.stateBudgetBytes;
    }
    return total;
  }

  assertStateBudget(room, nextRoomBytes) {
    const projected = this.loadedStateBytes() - room.stateBudgetBytes + nextRoomBytes;
    if (projected > MAX_TOTAL_ROOM_STATE_BYTES) {
      throw new ProtocolLimitError('Server-wide in-memory document budget is exhausted', 1013);
    }
  }

  assertBatchStateBudget(changes) {
    let projected = this.loadedStateBytes();
    for (const { room, stateBytes } of changes) projected += stateBytes - room.stateBudgetBytes;
    if (projected > MAX_TOTAL_ROOM_STATE_BYTES) {
      throw new ProtocolLimitError('Server-wide in-memory document budget is exhausted', 1013);
    }
  }

  async withRoomsLocked(rooms, operation) {
    const unique = [...new Set(rooms)].filter(Boolean);
    const predecessors = unique.map((room) => room.messageQueue ?? Promise.resolve());
    const releases = [];
    for (const [index, room] of unique.entries()) {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      releases.push(release);
      room.messageQueue = predecessors[index].catch(() => {}).then(() => gate);
    }
    await Promise.all(predecessors.map((pending) => pending.catch(() => {})));
    try {
      return await operation();
    } finally {
      for (const release of releases) release();
    }
  }

  async get(documentId) {
    const existing = this.rooms.get(documentId);
    if (existing) {
      const room = await existing;
      room.lastAccessAt = Date.now();
      return room;
    }
    if (this.rooms.size >= MAX_LOADED_ROOMS) await this.evictIdleRooms(true);
    if (this.rooms.size >= MAX_LOADED_ROOMS) {
      throw new ProtocolLimitError('Server has reached its active document limit', 1013);
    }
    const hash = crypto.createHash('sha256').update(documentId).digest('hex');
    if (!this.persisted.has(hash) && this.persisted.size >= MAX_PERSISTED_ROOMS) {
      throw new ProtocolLimitError('Server has reached its persisted document limit', 1013);
    }
    const loading = this.loadRoom(this.dataDirectory, documentId, this.authStore, this);
    this.rooms.set(documentId, loading);
    try {
      const room = await loading;
      room.persistenceGeneration = this.persistenceGenerations.get(hash) ?? 0;
      this.rooms.set(documentId, room);
      this.knownDocuments.set(hash, documentId);
      this.legacyDocumentsByBranch.get(documentId.split(':', 1)[0])?.delete(hash);
      this.assertStateBudget(room, room.stateBudgetBytes);
      return room;
    } catch (error) {
      const loaded = this.rooms.get(documentId);
      if (loaded === loading || typeof loaded?.destroy === 'function') this.rooms.delete(documentId);
      loaded?.destroy?.();
      throw error;
    }
  }

  async persistRoom(room, update, metadata, history) {
    room.persistenceGeneration ??= this.persistenceGenerations.get(room.hash) ?? 0;
    const generation = room.persistenceGeneration;
    const operation = this.persistencePromise.catch(() => {}).then(async () => {
      if (room.destroyed || (this.persistenceGenerations.get(room.hash) ?? 0) !== generation) return false;
      const nextBytes = update.length + byteLength(metadata) + byteLength(history);
      const previousBytes = this.persisted.get(room.hash) ?? 0;
      const projected = this.persistedTotalBytes - previousBytes + nextBytes;
      if ((!this.persisted.has(room.hash) && this.persisted.size >= MAX_PERSISTED_ROOMS)
        || projected > MAX_PERSISTED_DOCUMENT_BYTES) {
        throw new ProtocolLimitError('Persisted document storage budget is exhausted', 1013);
      }
      await this.atomicWrite(room.updatePath, update);
      await this.atomicWrite(room.metadataPath, metadata);
      await this.atomicWrite(room.historyPath, history);
      this.persisted.set(room.hash, nextBytes);
      this.persistedTotalBytes = projected;
      room.persistedBytes = nextBytes;
      if (typeof room.documentId === 'string') {
        this.knownDocuments.set(room.hash, room.documentId);
        this.legacyDocumentsByBranch.get(room.documentId.split(':', 1)[0])?.delete(room.hash);
        if (!this.indexedDocuments.has(room.hash)) await this.persistDocumentIndex();
      }
      if (room.gitBase?.branch && /^[0-9a-f]{40}$/u.test(room.gitBase.commit)) {
        this.branchHints.set(room.gitBase.branch, {
          commit: room.gitBase.commit, checkedAt: Number(room.gitBase.checkedAt ?? 0),
        });
      }
      return true;
    });
    this.persistencePromise = operation.then(() => undefined);
    await operation;
  }

  async evictIdleRooms(force = false) {
    const now = Date.now();
    const candidates = [];
    for (const [documentId, value] of this.rooms) {
      const room = await value;
      if (room.clients.size === 0 && (force || now - room.lastAccessAt >= ROOM_IDLE_MILLISECONDS)) {
        candidates.push([documentId, room]);
      }
    }
    candidates.sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt);
    for (const [documentId, room] of candidates) {
      if (force && this.rooms.size < MAX_LOADED_ROOMS) break;
      await room.flush();
      if (room.clients.size !== 0 || this.rooms.get(documentId) !== room) continue;
      this.rooms.delete(documentId);
      room.destroy();
    }
  }

  async deleteDocuments(documentIds, closeReason = 'Ticket deleted') {
    const removals = [];
    for (const documentId of documentIds) {
      const hash = crypto.createHash('sha256').update(documentId).digest('hex');
      this.persistenceGenerations.set(hash, (this.persistenceGenerations.get(hash) ?? 0) + 1);
      const loaded = this.rooms.get(documentId);
      if (loaded) {
        const room = await loaded;
        for (const client of room.clients) client.close(1001, closeReason);
        this.rooms.delete(documentId);
        room.destroy();
      }
      removals.push(hash);
    }
    const operation = this.persistencePromise.catch(() => {}).then(async () => {
      let indexChanged = false;
      for (const hash of removals) {
        const previousBytes = this.persisted.get(hash) ?? 0;
        await Promise.all([
          fs.rm(path.join(this.dataDirectory, 'documents', `${hash}.update`), { force: true }),
          fs.rm(path.join(this.dataDirectory, 'documents', `${hash}.json`), { force: true }),
          fs.rm(path.join(this.dataDirectory, 'documents', `${hash}.history.json`), { force: true }),
        ]);
        this.persisted.delete(hash);
        if (this.knownDocuments.delete(hash)) indexChanged = true;
        this.indexedDocuments.delete(hash);
        for (const legacy of this.legacyDocumentsByBranch.values()) legacy.delete(hash);
        this.persistedTotalBytes = Math.max(0, this.persistedTotalBytes - previousBytes);
      }
      if (indexChanged) await this.persistDocumentIndex();
    });
    this.persistencePromise = operation;
    await operation;
  }

  async close() {
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    if (this.canonicalTimer) clearInterval(this.canonicalTimer);
    this.evictionTimer = null;
    this.canonicalTimer = null;
    await this.persistencePromise.catch(() => {});
  }
}
