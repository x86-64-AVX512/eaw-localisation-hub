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

export async function collectLocalisationKeys(repository, fileCache = new Map()) {
  const canonicalRepository = await fs.realpath(repository);
  const root = path.join(canonicalRepository, 'localisation');
  let canonicalRoot;
  try { canonicalRoot = await fs.realpath(root); }
  catch (error) {
    if (error.code === 'ENOENT') { fileCache.clear(); return { keys: [], complete: true, files: 0 }; }
    throw error;
  }
  if (!inside(canonicalRepository, canonicalRoot)) throw new Error('Localisation directory is outside the repository');
  const keys = new Set();
  const directories = [canonicalRoot];
  const seen = new Set();
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
      const stat = await fs.stat(canonical, { bigint: true });
      const size = Number(stat.size);
      if (++files > MAX_FILES || size > MAX_FILE_BYTES || (bytes += size) > MAX_TOTAL_BYTES) {
        complete = false;
        break;
      }
      seen.add(canonical);
      const cached = fileCache.get(canonical);
      let fileKeys;
      if (cached?.size === stat.size && cached.mtimeNs === stat.mtimeNs
        && cached.ctimeNs === stat.ctimeNs) fileKeys = cached.keys;
      else {
        const body = await fs.readFile(canonical, 'utf8');
        KEY_LINE.lastIndex = 0;
        fileKeys = [...body.matchAll(KEY_LINE)].map((match) => match[1].trim());
        fileCache.set(canonical, { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, keys: fileKeys });
      }
      for (const key of fileKeys) keys.add(key);
    }
  }
  for (const file of fileCache.keys()) if (!seen.has(file)) fileCache.delete(file);
  return { keys: complete ? [...keys] : [], complete, files };
}

if (parentPort) {
  const fileCache = new Map();
  let previous = null;
  let queue = Promise.resolve();
  parentPort.on('message', ({ id }) => {
    queue = queue.then(async () => {
      const result = await collectLocalisationKeys(workerData.repository, fileCache);
      const unchanged = previous?.complete === result.complete && previous.files === result.files
        && previous.keys.length === result.keys.length
        && previous.keys.every((key, index) => key === result.keys[index]);
      previous = result;
      parentPort.postMessage(unchanged ? { id, unchanged: true } : { id, result });
    }).catch((error) => parentPort.postMessage({ id, error: error.message }));
  });
}
