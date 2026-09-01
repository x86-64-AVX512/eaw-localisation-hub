import fs from 'node:fs/promises';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const ALLOWED_ROOTS = new Set(['auth.json', 'recovery-pepper.key', 'tickets.json', 'documents']);

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

export async function createBackupBundle(dataDirectory, version) {
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
  const files = [];
  for (const relativePath of selected.sort()) {
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

function safeBackupPath(dataDirectory, relativePath) {
  const normalised = String(relativePath).replaceAll('\\', '/');
  if (!normalised || normalised.startsWith('/') || normalised.includes('../')) {
    throw new Error(`Unsafe backup path: ${relativePath}`);
  }
  const first = normalised.split('/')[0];
  if (!ALLOWED_ROOTS.has(first)) throw new Error(`Unsupported backup path: ${relativePath}`);
  const target = path.resolve(dataDirectory, normalised);
  const root = `${path.resolve(dataDirectory)}${path.sep}`;
  const allowedRootFile = ['auth.json', 'recovery-pepper.key', 'tickets.json']
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
