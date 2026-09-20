import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const KEY_LINE = /^[ \t]*([^#\s][^:\r\n]*):(?:\d+)?[ \t]+(?=\S)/gmu;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function collectLocalisationKeys(repository) {
  const canonicalRepository = await fs.realpath(repository);
  const root = path.join(canonicalRepository, 'localisation');
  let canonicalRoot;
  try { canonicalRoot = await fs.realpath(root); }
  catch (error) {
    if (error.code === 'ENOENT') return { keys: [], complete: true, files: 0 };
    throw error;
  }
  if (!inside(canonicalRepository, canonicalRoot)) throw new Error('Localisation directory is outside the repository');
  const keys = new Set();
  const directories = [canonicalRoot];
  let files = 0; let bytes = 0; let complete = true;
  while (directories.length && complete) {
    const directory = directories.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { directories.push(location); continue; }
      if (!entry.isFile() || !/\.ya?ml$/iu.test(entry.name)) continue;
      const canonical = await fs.realpath(location);
      if (!inside(canonicalRepository, canonical)) continue;
      const stat = await fs.stat(canonical);
      if (++files > MAX_FILES || stat.size > MAX_FILE_BYTES || (bytes += stat.size) > MAX_TOTAL_BYTES) {
        complete = false;
        break;
      }
      const body = await fs.readFile(canonical, 'utf8');
      KEY_LINE.lastIndex = 0;
      for (const match of body.matchAll(KEY_LINE)) keys.add(match[1].trim());
    }
  }
  return { keys: complete ? [...keys] : [], complete, files };
}

if (parentPort) collectLocalisationKeys(workerData.repository)
  .then((result) => parentPort.postMessage({ result }))
  .catch((error) => parentPort.postMessage({ error: error.message }));
