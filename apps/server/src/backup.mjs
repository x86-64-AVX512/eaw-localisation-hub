import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGzip, gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const ALLOWED_ROOTS = new Set(['auth.json', 'recovery-pepper.key', 'tickets.json', 'branch-merges.json', 'room-index.json', 'documents', 'audit', 'events.json']);

async function collectFiles(root, relative = '') {
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, child));
    else if (entry.isFile()) files.push(child.replaceAll('\\', '/'));
  }
  return files;
}

async function selectedBackupFiles(dataDirectory) {
  const selected = [];
  for (const rootEntry of ALLOWED_ROOTS) {
    const absolute = path.join(dataDirectory, rootEntry);
    try {
      const info = await fs.stat(absolute);
      if (info.isFile()) selected.push(rootEntry);
      else if (info.isDirectory()) selected.push(...await collectFiles(dataDirectory, rootEntry));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return selected.sort();
}

export async function createBackupBundle(dataDirectory, version) {
  const files = [];
  for (const relativePath of await selectedBackupFiles(dataDirectory)) {
    const data = await fs.readFile(path.join(dataDirectory, relativePath));
    files.push({ path: relativePath, dataBase64: data.toString('base64') });
  }
  const payload = Buffer.from(JSON.stringify({
    schema: 1,
    version,
    createdAt: new Date().toISOString(),
    files,
  }), 'utf8');
  return gzipAsync(payload, { level: 9 });
}

// The HTTP route must not hold the full (base64-expanded) backup in the
// server's limited container memory before it can send the first byte.
export async function streamBackupBundle(dataDirectory, version) {
  const selected = await selectedBackupFiles(dataDirectory);
  async function* jsonChunks() {
    yield `{"schema":1,"version":${JSON.stringify(version)},"createdAt":${JSON.stringify(new Date().toISOString())},"files":[`;
    for (let index = 0; index < selected.length; index += 1) {
      const relativePath = selected[index];
      yield `${index ? ',' : ''}{"path":${JSON.stringify(relativePath)},"dataBase64":"`;
      let remainder = Buffer.alloc(0);
      for await (const chunk of createReadStream(path.join(dataDirectory, relativePath))) {
        const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
        const completeLength = bytes.length - (bytes.length % 3);
        if (completeLength) yield bytes.subarray(0, completeLength).toString('base64');
        remainder = bytes.subarray(completeLength);
      }
      if (remainder.length) yield remainder.toString('base64');
      yield '"}';
    }
    yield ']}';
  }
  return Readable.from(jsonChunks()).pipe(createGzip({ level: 6 }));
}

function safeBackupPath(dataDirectory, relativePath) {
  const normalised = String(relativePath).replaceAll('\\', '/');
  if (!normalised || normalised.startsWith('/') || normalised.includes('../')) {
    throw new Error(`Unsafe backup path: ${relativePath}`);
  }
  const first = normalised.split('/')[0];
  if (!ALLOWED_ROOTS.has(first)) throw new Error(`Unsupported backup path: ${relativePath}`);
  const target = path.resolve(dataDirectory, normalised);
  const root = `${path.resolve(dataDirectory)}${path.sep}`;
  const allowedRootFile = ['auth.json', 'recovery-pepper.key', 'tickets.json', 'branch-merges.json', 'room-index.json']
    .some((name) => target === path.resolve(dataDirectory, name));
  if (!allowedRootFile && !target.startsWith(root)) {
    throw new Error(`Backup path escapes the data directory: ${relativePath}`);
  }
  return target;
}

export async function restoreBackupBundle(bundle, dataDirectory, atomicWrite) {
  const decoded = JSON.parse((await gunzipAsync(bundle)).toString('utf8'));
  if (decoded.schema !== 1 || !Array.isArray(decoded.files)) {
    throw new Error('Unsupported or invalid EaW Hub backup');
  }
  for (const file of decoded.files) {
    const target = safeBackupPath(dataDirectory, file.path);
    await atomicWrite(target, Buffer.from(String(file.dataBase64 ?? ''), 'base64'));
  }
  return {
    version: decoded.version,
    createdAt: decoded.createdAt,
    files: decoded.files.length,
  };
}
