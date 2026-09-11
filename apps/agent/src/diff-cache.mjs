import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const CACHE_SCHEMA = 1;
const DEFAULT_MAXIMUM_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAXIMUM_ENTRIES = 512;
const DEFAULT_MAXIMUM_ENTRY_BYTES = 64 * 1024 * 1024;
const CACHE_FILE = /^[0-9a-f]{64}\.json\.gz$/u;

function cacheIdentity(namespace, key) {
  return `${String(namespace)}\0${String(key)}`;
}

export class DiffCache {
  constructor(directory, options = {}) {
    this.directory = path.resolve(directory);
    this.maximumBytes = Number(options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES);
    this.maximumEntries = Number(options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES);
    this.maximumEntryBytes = Number(options.maximumEntryBytes ?? DEFAULT_MAXIMUM_ENTRY_BYTES);
    this.maintenance = Promise.resolve();
  }

  async initialise() {
    await fs.mkdir(this.directory, { recursive: true });
    return this;
  }

  target(namespace, key) {
    const digest = crypto.createHash('sha256').update(cacheIdentity(namespace, key)).digest('hex');
    return path.join(this.directory, `${digest}.json.gz`);
  }

  async get(namespace, key) {
    const target = this.target(namespace, key);
    try {
      const compressed = await fs.readFile(target);
      const envelope = JSON.parse((await decompress(compressed, {
        maxOutputLength: this.maximumEntryBytes,
      })).toString('utf8'));
      if (envelope.schema !== CACHE_SCHEMA
          || envelope.namespace !== String(namespace)
          || envelope.key !== String(key)) {
        throw new Error('Diff cache identity mismatch');
      }
      const now = new Date();
      await fs.utimes(target, now, now).catch(() => {});
      return envelope.value;
    } catch (error) {
      if (error.code !== 'ENOENT') await fs.rm(target, { force: true }).catch(() => {});
      return undefined;
    }
  }

  async set(namespace, key, value) {
    const source = Buffer.from(JSON.stringify({
      schema: CACHE_SCHEMA,
      namespace: String(namespace),
      key: String(key),
      value,
    }), 'utf8');
    if (source.length > this.maximumEntryBytes) return false;
    const compressed = await compress(source, { level: 6 });
    const operation = this.maintenance.then(async () => {
      const target = this.target(namespace, key);
      try {
        const now = new Date();
        await fs.utimes(target, now, now);
        await this.prune();
        return true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await this.initialise();
      await fs.writeFile(temporary, compressed, { flag: 'wx', mode: 0o600 });
      try {
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        try {
          await fs.access(target);
        } catch {
          throw error;
        }
      }
      await this.prune();
      return true;
    });
    this.maintenance = operation.catch(() => {});
    return operation;
  }

  async getOrCreate(namespace, key, create) {
    const cached = await this.get(namespace, key);
    if (cached !== undefined) return cached;
    const value = await create();
    await this.set(namespace, key, value).catch(() => false);
    return value;
  }

  async files() {
    await this.initialise();
    const names = await fs.readdir(this.directory);
    const entries = await Promise.all(names.filter((name) => CACHE_FILE.test(name)).map(async (name) => {
      const target = path.join(this.directory, name);
      try {
        const stat = await fs.stat(target);
        return { target, bytes: stat.size, accessedAt: stat.mtimeMs };
      } catch { return null; }
    }));
    return entries.filter(Boolean);
  }

  async stats() {
    const entries = await this.files();
    return {
      entries: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      maximumBytes: this.maximumBytes,
      maximumEntries: this.maximumEntries,
    };
  }

  async prune() {
    const entries = (await this.files()).sort((left, right) => left.accessedAt - right.accessedAt);
    let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    let count = entries.length;
    for (const entry of entries) {
      if (bytes <= this.maximumBytes && count <= this.maximumEntries) break;
      await fs.rm(entry.target, { force: true }).catch(() => {});
      bytes -= entry.bytes;
      count -= 1;
    }
  }

  async clear() {
    const operation = this.maintenance.then(async () => {
      const before = await this.stats();
      await fs.rm(this.directory, { recursive: true, force: true });
      await fs.mkdir(this.directory, { recursive: true });
      return before;
    });
    this.maintenance = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export const diffCacheLimits = Object.freeze({
  maximumBytes: DEFAULT_MAXIMUM_BYTES,
  maximumEntries: DEFAULT_MAXIMUM_ENTRIES,
  maximumEntryBytes: DEFAULT_MAXIMUM_ENTRY_BYTES,
});
