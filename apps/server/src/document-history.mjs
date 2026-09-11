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
  mergeLocalisationThreeWay,
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

function suggestionFields(suggestion) {
  if (!suggestion) return {};
  return {
    suggestionId: suggestion.id ? String(suggestion.id) : null,
    suggestionAuthorId: suggestion.authorId ? String(suggestion.authorId) : null,
    suggestionAuthor: String(suggestion.author ?? 'Unknown'),
    suggestionColor: String(suggestion.color ?? '#8a8a8a'),
  };
}

function appliesSuggestion(previous, current, suggestion) {
  const original = String(suggestion.originalText ?? '');
  const replacement = String(suggestion.replacementText ?? '');
  if (!original && !replacement) return false;
  if (!original) {
    let index = current.indexOf(replacement);
    while (index >= 0) {
      if (`${current.slice(0, index)}${current.slice(index + replacement.length)}` === previous) return true;
      index = current.indexOf(replacement, index + 1);
    }
    return false;
  }
  let index = previous.indexOf(original);
  while (index >= 0) {
    if (`${previous.slice(0, index)}${replacement}${previous.slice(index + original.length)}` === current) {
      return true;
    }
    index = previous.indexOf(original, index + 1);
  }
  return false;
}

export class DocumentHistory {
  constructor(target) {
    this.target = target;
    this.entries = [];
    this.ownership = new Map();
    this.ownerNames = new Map();
    this.authorVariants = new Map();
    this.gitBaseText = null;
    this.rebaseConflicts = new Map();
  }

  async load() {
    try {
      if ((await fs.stat(this.target)).size > MAX_STORED_BYTES) throw new Error('Persisted history exceeds its limit');
      const value = JSON.parse(await fs.readFile(this.target, 'utf8'));
      this.gitBaseText = typeof value.gitBaseGzipBase64 === 'string'
        ? unpackText({ textGzipBase64: value.gitBaseGzipBase64 }) : null;
      this.rebaseConflicts = new Map((value.rebaseConflicts ?? []).map(({ authorId, conflicts }) => [
        String(authorId), new Map(conflicts.map((conflict) => [conflict.key, conflict])),
      ]));
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
    this.gitBaseText = text;
    return this.record(text, null, 'baseline', { coalesce: false });
  }

  record(text, actor, reason = 'edit', { coalesce = true, suggestion = null } = {}) {
    if (byteLength(text) > MAX_TEXT_BYTES) return false;
    const now = new Date().toISOString();
    const identity = actorFields(actor);
    const previous = this.entries.at(-1);
    const previousText = previous ? (previous._text ?? unpackText(previous)) : text;
    if (previous && previousText === text) return false;
    if (this.entries.length === 1 && previous?.reason === 'baseline' && !previousText && text) {
      if (this.gitBaseText === previousText) this.gitBaseText = text;
      Object.assign(previous, { id: crypto.randomUUID(), updatedAt: now, _text: text });
      delete previous.textGzipBase64;
      return true;
    }
    if (identity.authorId && reason !== 'baseline') {
      const variant = this.authorVariants.get(identity.authorId) ?? new Map();
      for (const [key, line] of captureLocalisationVariant(previousText, text)) {
        this.ownership.set(key, identity.authorId);
        variant.set(key, line);
        this.rebaseConflicts.get(identity.authorId)?.delete(key);
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
        id: crypto.randomUUID(), ...identity, ...suggestionFields(suggestion),
        reason, createdAt: now, updatedAt: now,
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
    this.updateGitBase(String(gitText ?? ''));
    const identity = String(userId ?? '');
    if (!identity || !this.entries.length) return String(gitText ?? '');
    const variant = this.authorVariants.get(identity);
    if (variant) return projectLocalisationVariant(String(gitText ?? ''), variant);
    const current = this.entries.at(-1)._text ?? unpackText(this.entries.at(-1));
    return projectLocalisationOwnership(String(gitText ?? ''), current, this.ownership, identity);
  }

  replacePersonalProjection(actor, text, gitText) {
    const identity = actorFields(actor);
    if (!identity.authorId) return false;
    const base = String(gitText ?? '');
    this.updateGitBase(base);
    const next = captureLocalisationVariant(base, String(text ?? ''));
    const previous = this.authorVariants.get(identity.authorId);
    const variantChanged = !previous || previous.size !== next.size
      || [...next].some(([key, line]) => previous.get(key) !== line);
    const nameChanged = this.ownerNames.get(identity.authorId) !== identity.author;
    this.authorVariants.set(identity.authorId, next);
    this.ownerNames.set(identity.authorId, identity.author);
    const conflictsChanged = this.rebaseConflicts.delete(identity.authorId);
    return variantChanged || nameChanged || conflictsChanged;
  }

  contributors() {
    return [...new Set([...this.ownership.values(), ...this.authorVariants.keys()])]
      .map((id) => ({ id, displayName: this.ownerNames.get(id) ?? 'Unknown' }));
  }

  reconcileSuggestionAttribution(suggestions) {
    const accepted = (Array.isArray(suggestions) ? suggestions : [])
      .filter(({ status }) => status === 'accepted');
    let previous = this.entries[0]?._text ?? (this.entries[0] ? unpackText(this.entries[0]) : '');
    let changed = false;
    for (const entry of this.entries.slice(1)) {
      const current = entry._text ?? unpackText(entry);
      if (entry.reason !== 'suggestion' || entry.suggestionAuthor !== undefined) {
        previous = current;
        continue;
      }
      const creator = {
        id: entry.authorId,
        displayName: entry.author,
        color: entry.color,
      };
      const candidates = accepted.filter((item) => (
        (!creator.id || item.authorId === creator.id)
        && appliesSuggestion(previous, current, item)
      ));
      const decisions = new Set(candidates.map((item) => `${item.decidedById ?? ''}\0${item.decidedBy ?? ''}`));
      const matched = decisions.size === 1 ? candidates[0] : null;
      Object.assign(entry, suggestionFields({
        id: matched?.id,
        authorId: creator.id,
        author: creator.displayName,
        color: creator.color,
      }), matched?.decidedBy ? {
        authorId: matched.decidedById ? String(matched.decidedById) : null,
        author: String(matched.decidedBy),
        color: '#8a8a8a',
      } : {
        authorId: null,
        author: 'Unknown',
        color: '#8a8a8a',
      });
      for (const [key, line] of captureLocalisationVariant(previous, current)) {
        const creatorVariant = creator.id ? this.authorVariants.get(creator.id) : null;
        const migratedCreatorLine = creatorVariant?.get(key) === line;
        if (migratedCreatorLine) {
          creatorVariant.delete(key);
          this.rebaseConflicts.get(creator.id)?.delete(key);
        }
        if (migratedCreatorLine && this.ownership.get(key) === creator.id) {
          if (entry.authorId) this.ownership.set(key, entry.authorId);
          else this.ownership.delete(key);
        }
        if (entry.authorId) {
          const accepterVariant = this.authorVariants.get(entry.authorId) ?? new Map();
          if (!accepterVariant.has(key)) accepterVariant.set(key, line);
          this.authorVariants.set(entry.authorId, accepterVariant);
          this.ownerNames.set(entry.authorId, entry.author);
        }
      }
      changed = true;
      previous = current;
    }
    return changed;
  }

  conflicts(gitText, subjectAuthorId = '') {
    this.updateGitBase(String(gitText ?? ''));
    const conflicts = localisationVariantConflicts(
      String(gitText ?? ''), this.authorVariants, this.ownerNames,
    );
    const subject = String(subjectAuthorId ?? '');
    return subject
      ? conflicts.filter(({ variants }) => variants.some(({ authorId }) => authorId === subject))
      : conflicts;
  }

  updateGitBase(nextGitText) {
    if (this.gitBaseText === nextGitText) return false;
    for (const [authorId, variant] of this.authorVariants) {
      const previousGit = this.gitBaseText ?? nextGitText;
      const personal = projectLocalisationVariant(previousGit, variant);
      const merged = mergeLocalisationThreeWay(previousGit, personal, nextGitText);
      const rebased = captureLocalisationVariant(nextGitText, merged.text);
      const pending = this.rebaseConflicts.get(authorId) ?? new Map();
      for (const key of pending.keys()) if (!rebased.has(key)) pending.delete(key);
      for (const conflict of merged.conflicts) pending.set(conflict.key, conflict);
      if (this.gitBaseText === null) {
        // Older histories stored no Git ancestry. Preserve their variants, but
        // require a choice before an unproven old line can overwrite today's HEAD.
        for (const key of rebased.keys()) pending.set(key, {
          key, label: key === '__file_structure__' ? 'Структура файла' : key,
          baseLine: null, collaborativeLine: key === '__file_structure__' ? null : rebased.get(key),
          externalLine: null, reason: 'legacy-base-unknown',
        });
      }
      this.authorVariants.set(authorId, rebased);
      this.rebaseConflicts.set(authorId, pending);
    }
    this.gitBaseText = nextGitText;
    return true;
  }

  personalGitConflicts(userId) {
    return [...(this.rebaseConflicts.get(String(userId))?.values() ?? [])].map((conflict) => ({
      ...conflict,
      id: crypto.createHash('sha256').update(JSON.stringify([this.gitBaseText, conflict])).digest('hex'),
    }));
  }

  resolvePersonalGitConflict(userId, key, choice, conflictId) {
    const identity = String(userId);
    const pending = this.rebaseConflicts.get(identity);
    if (!pending?.has(key) || !['mine', 'git'].includes(choice)) return false;
    if (this.personalGitConflicts(identity).find((item) => item.key === key)?.id !== conflictId) return false;
    if (choice === 'git') this.authorVariants.get(identity)?.delete(key);
    pending.delete(key);
    return true;
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
      if (entry.authorId === userId) {
        Object.assign(entry, { authorId: null, author: 'Deleted user', color: '#8a8a8a' });
        changed = true;
      }
      if (entry.suggestionAuthorId === userId) {
        Object.assign(entry, {
          suggestionAuthorId: null,
          suggestionAuthor: 'Deleted user',
          suggestionColor: '#8a8a8a',
        });
        changed = true;
      }
    }
    for (const [key, ownerId] of this.ownership) {
      if (ownerId === userId) {
        this.ownership.set(key, '__deleted__');
        changed = true;
      }
    }
    this.ownerNames.delete(userId);
    if (this.rebaseConflicts.has(userId)) {
      this.rebaseConflicts.set('__deleted__', this.rebaseConflicts.get(userId));
      this.rebaseConflicts.delete(userId);
    }
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
    const gitBaseGzipBase64 = this.gitBaseText === null ? null : packedText(this.gitBaseText);
    const rebaseConflicts = [...this.rebaseConflicts].map(([authorId, conflicts]) => ({ authorId, conflicts: [...conflicts.values()] }));
    const serialise = () => `${JSON.stringify({ schema: 5, entries: persisted, ownership, authorVariants, gitBaseGzipBase64, rebaseConflicts }, null, 2)}\n`;
    let value = serialise();
    while (this.entries.length > 2 && byteLength(value) > MAX_STORED_BYTES) {
      this.entries.shift();
      persisted.shift();
      value = serialise();
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
