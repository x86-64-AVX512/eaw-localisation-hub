import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_LOADED_ROOMS,
  MAX_PERSISTED_DOCUMENT_BYTES,
  MAX_PERSISTED_ROOMS,
  MAX_TOTAL_ROOM_STATE_BYTES,
  ROOM_IDLE_MILLISECONDS,
} from '../../../packages/shared/src/constants.mjs';
import { ProtocolLimitError, byteLength } from './protocol-limits.mjs';

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
  }

  async initialise() {
    const directory = path.join(this.dataDirectory, 'documents');
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
    }
    if (this.persisted.size > MAX_PERSISTED_ROOMS
      || this.persistedTotalBytes > MAX_PERSISTED_DOCUMENT_BYTES) {
      throw new Error('Persisted document storage already exceeds the configured safety budget');
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
      if (room.clients.size > 0) await room.refreshCanonical();
    }
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
      this.rooms.set(documentId, room);
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
    const operation = this.persistencePromise.catch(() => {}).then(async () => {
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
    });
    this.persistencePromise = operation;
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

  async deleteDocuments(documentIds) {
    for (const documentId of documentIds) {
      const hash = crypto.createHash('sha256').update(documentId).digest('hex');
      const loaded = this.rooms.get(documentId);
      if (loaded) {
        const room = await loaded;
        for (const client of room.clients) client.close(1001, 'Ticket deleted');
        this.rooms.delete(documentId);
        room.destroy();
      }
      const previousBytes = this.persisted.get(hash) ?? 0;
      await Promise.all([
        fs.rm(path.join(this.dataDirectory, 'documents', `${hash}.update`), { force: true }),
        fs.rm(path.join(this.dataDirectory, 'documents', `${hash}.json`), { force: true }),
        fs.rm(path.join(this.dataDirectory, 'documents', `${hash}.history.json`), { force: true }),
      ]);
      this.persisted.delete(hash);
      this.persistedTotalBytes = Math.max(0, this.persistedTotalBytes - previousBytes);
    }
  }

  async close() {
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    if (this.canonicalTimer) clearInterval(this.canonicalTimer);
    this.evictionTimer = null;
    this.canonicalTimer = null;
    await this.persistencePromise.catch(() => {});
  }
}
