import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import { byteLength } from './protocol-limits.mjs';
import {
  captureLocalisationVariant,
  localisationVariantConflicts,
  localisationChangedKeys,
  projectLocalisationVariant,
  projectLocalisationOwnership,
} from '../../../packages/shared/src/merge.mjs';

const MAX_ENTRIES = 100;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_STORED_BYTES = 24 * 1024 * 1024;
const EDIT_SESSION_MILLISECONDS = 60 * 1000;

function packedText(text) {
  if (byteLength(text) > MAX_TEXT_BYTES) return null;
  return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 6 }).toString('base64');
}

function unpackText(entry) {
  return zlib.gunzipSync(Buffer.from(entry.textGzipBase64, 'base64')).toString('utf8');
}

function actorFields(actor) {
  return {
    authorId: actor?.id ? String(actor.id) : null,
    author: String(actor?.displayName ?? 'EaW Hub'),
    color: String(actor?.color ?? '#8a8a8a'),
  };
}

export class DocumentHistory {
  constructor(target) {
    this.target = target;
    this.entries = [];
    this.ownership = new Map();
    this.ownerNames = new Map();
    this.authorVariants = new Map();
  }

  async load() {
    try {
      if ((await fs.stat(this.target)).size > MAX_STORED_BYTES) throw new Error('Persisted history exceeds its limit');
      const value = JSON.parse(await fs.readFile(this.target, 'utf8'));
      this.entries = (Array.isArray(value.entries) ? value.entries : [])
        .filter((entry) => entry?.id && entry?.textGzipBase64)
        .slice(-MAX_ENTRIES);
      for (const item of Array.isArray(value.ownership) ? value.ownership : []) {
        if (!item?.key || !item?.ownerId) continue;
        this.ownership.set(String(item.key), String(item.ownerId));
        this.ownerNames.set(String(item.ownerId), String(item.ownerName ?? 'Unknown'));
      }
      for (const author of Array.isArray(value.authorVariants) ? value.authorVariants : []) {
        if (!author?.authorId || !Array.isArray(author.values)) continue;
        this.authorVariants.set(String(author.authorId), new Map(author.values.map((item) => [
          String(item.key), item.line === null ? null : String(item.line ?? ''),
        ])));
        this.ownerNames.set(String(author.authorId), String(author.authorName ?? 'Unknown'));
      }
      if (!this.ownership.size) this.rebuildOwnership();
      if (!this.authorVariants.size) this.rebuildAuthorVariants();
      this.prune();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  summaries() {
    return this.entries.toReversed().map(({ textGzipBase64: _packed, _text, ...entry }) => entry);
  }

  headId() {
    return this.entries.at(-1)?.id ?? '';
  }

  ensureBaseline(text) {
    if (this.entries.length) return false;
    return this.record(text, null, 'baseline', { coalesce: false });
  }

  record(text, actor, reason = 'edit', { coalesce = true } = {}) {
    if (byteLength(text) > MAX_TEXT_BYTES) return false;
    const now = new Date().toISOString();
    const identity = actorFields(actor);
    const previous = this.entries.at(-1);
    const previousText = previous ? (previous._text ?? unpackText(previous)) : text;
    if (previous && previousText === text) return false;
    if (this.entries.length === 1 && previous?.reason === 'baseline' && !previousText && text) {
      Object.assign(previous, { id: crypto.randomUUID(), updatedAt: now, _text: text });
      delete previous.textGzipBase64;
      return true;
    }
    if (identity.authorId && reason !== 'baseline') {
      const variant = this.authorVariants.get(identity.authorId) ?? new Map();
      for (const [key, line] of captureLocalisationVariant(previousText, text)) {
        this.ownership.set(key, identity.authorId);
        variant.set(key, line);
      }
      this.authorVariants.set(identity.authorId, variant);
      this.ownerNames.set(identity.authorId, identity.author);
    }
    if (coalesce && reason === 'edit' && previous?.reason === 'edit'
      && previous.authorId === identity.authorId
      && Date.now() - Date.parse(previous.updatedAt ?? previous.createdAt) <= EDIT_SESSION_MILLISECONDS) {
      Object.assign(previous, identity, { id: crypto.randomUUID(), updatedAt: now, _text: text });
      delete previous.textGzipBase64;
    } else {
      this.entries.push({
        id: crypto.randomUUID(), ...identity, reason, createdAt: now, updatedAt: now,
        _text: text,
      });
    }
    this.prune();
    return true;
  }

  text(id) {
    const entry = this.entries.find((item) => item.id === id);
    return entry ? entry._text ?? unpackText(entry) : null;
  }

  personalProjection(userId, gitText) {
    const identity = String(userId ?? '');
    if (!identity || !this.entries.length) return String(gitText ?? '');
    const variant = this.authorVariants.get(identity);
    if (variant) return projectLocalisationVariant(String(gitText ?? ''), variant);
    const current = this.entries.at(-1)._text ?? unpackText(this.entries.at(-1));
    return projectLocalisationOwnership(String(gitText ?? ''), current, this.ownership, identity);
  }

  contributors() {
    return [...new Set([...this.ownership.values(), ...this.authorVariants.keys()])]
      .map((id) => ({ id, displayName: this.ownerNames.get(id) ?? 'Unknown' }));
  }

  conflicts(gitText) {
    return localisationVariantConflicts(String(gitText ?? ''), this.authorVariants, this.ownerNames);
  }

  rebuildOwnership() {
    let previous = this.entries[0]?._text ?? (this.entries[0] ? unpackText(this.entries[0]) : '');
    for (const entry of this.entries.slice(1)) {
      const current = entry._text ?? unpackText(entry);
      if (entry.authorId) {
        for (const key of localisationChangedKeys(previous, current)) this.ownership.set(key, entry.authorId);
        this.ownerNames.set(entry.authorId, entry.author);
      }
      previous = current;
    }
  }

  rebuildAuthorVariants() {
    let previous = this.entries[0]?._text ?? (this.entries[0] ? unpackText(this.entries[0]) : '');
    for (const entry of this.entries.slice(1)) {
      const current = entry._text ?? unpackText(entry);
      if (entry.authorId) {
        const variant = this.authorVariants.get(entry.authorId) ?? new Map();
        for (const [key, line] of captureLocalisationVariant(previous, current)) variant.set(key, line);
        this.authorVariants.set(entry.authorId, variant);
        this.ownerNames.set(entry.authorId, entry.author);
      }
      previous = current;
    }
  }

  anonymise(userId) {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.authorId !== userId) continue;
      Object.assign(entry, { authorId: null, author: 'Deleted user', color: '#8a8a8a' });
      changed = true;
    }
    for (const [key, ownerId] of this.ownership) {
      if (ownerId === userId) {
        this.ownership.set(key, '__deleted__');
        changed = true;
      }
    }
    this.ownerNames.delete(userId);
    this.ownerNames.set('__deleted__', 'Deleted user');
    if (this.authorVariants.has(userId)) {
      this.authorVariants.set('__deleted__', this.authorVariants.get(userId));
      this.authorVariants.delete(userId);
      changed = true;
    }
    return changed;
  }

  prune() {
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  serialise() {
    const persisted = this.entries.map((item) => {
      item.textGzipBase64 ??= packedText(item._text);
      const { _text, ...entry } = item;
      return entry;
    });
    const ownership = [...this.ownership].map(([key, ownerId]) => ({
      key, ownerId, ownerName: this.ownerNames.get(ownerId) ?? 'Unknown',
    }));
    const authorVariants = [...this.authorVariants].map(([authorId, variant]) => ({
      authorId, authorName: this.ownerNames.get(authorId) ?? 'Unknown',
      values: [...variant].map(([key, line]) => ({ key, line })),
    }));
    let value = `${JSON.stringify({ schema: 3, entries: persisted, ownership, authorVariants }, null, 2)}\n`;
    while (this.entries.length > 2 && byteLength(value) > MAX_STORED_BYTES) {
      this.entries.shift();
      persisted.shift();
      value = `${JSON.stringify({ schema: 3, entries: persisted, ownership, authorVariants }, null, 2)}\n`;
    }
    return value;
  }
}

export async function anonymisePersistedHistory(dataDirectory, userId, atomicWrite) {
  const directory = path.join(dataDirectory, 'documents');
  let names = [];
  try {
    names = (await fs.readdir(directory)).filter((name) => /^[0-9a-f]{64}\.history\.json$/u.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const history = new DocumentHistory(path.join(directory, name));
    await history.load();
    if (history.anonymise(userId)) await atomicWrite(history.target, history.serialise());
  }
}
