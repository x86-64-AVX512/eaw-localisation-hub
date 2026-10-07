import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { parseLocalisationRecords, localisationLanguage } from '../../../packages/shared/src/localisation-records.mts';
import { collectScriptedLocalisation, documentedGetterNames, documentedGetterStamp } from './scripted-localisation-index.mjs';

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function collectLocalisationKeys(repository, fileCache = new Map(), scriptCache = new Map()) {
  const canonicalRepository = await fs.realpath(repository);
  const scripted = await collectScriptedLocalisation(canonicalRepository, scriptCache);
  const documentedGetters = await documentedGetterNames();
  const root = path.join(canonicalRepository, 'localisation');
  let canonicalRoot;
  try { canonicalRoot = await fs.realpath(root); }
  catch (error) {
    if (error.code === 'ENOENT') { fileCache.clear(); return { complete: true, files: 0,
      languages: {}, scripted, documentedGetters }; }
    throw error;
  }
  if (!inside(canonicalRepository, canonicalRoot)) throw new Error('Localisation directory is outside the repository');
  // Each key is sent once, under its language. The game ignores files without
  // one, so their declarations cannot satisfy a reference and are not indexed.
  const languageKeys = new Map();
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
      let fileKeys, language;
      if (cached?.size === stat.size && cached.mtimeNs === stat.mtimeNs
        && cached.ctimeNs === stat.ctimeNs) { fileKeys = cached.keys; language = cached.language; }
      else {
        const body = await fs.readFile(canonical, 'utf8');
        fileKeys = parseLocalisationRecords(body).filter((record) => !record.fault).map((record) => record.key);
        language = localisationLanguage(path.relative(canonicalRepository, canonical), body);
        fileCache.set(canonical, { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, keys: fileKeys, language });
      }
      if (!language) continue;
      const target = languageKeys.get(language) ?? new Set();
      for (const key of fileKeys) target.add(key);
      languageKeys.set(language, target);
    }
  }
  for (const file of fileCache.keys()) if (!seen.has(file)) fileCache.delete(file);
  const languages = Object.fromEntries([...languageKeys].sort(([a], [b]) => a.localeCompare(b))
    .map(([language, values]) => [language, { complete, keys: complete ? [...values].sort() : [] }]));
  return { complete, files, languages, scripted, documentedGetters };
}

// Fingerprint the inputs rather than serialising the whole inventory: unchanged
// files keep their cached parse, so equal stamps imply an equal result.
export function keyIndexInputSignature(result, fileCache, scriptCache) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify([result.complete, result.files, result.scripted.complete, documentedGetterStamp()]));
  for (const cache of [fileCache, scriptCache]) {
    for (const [file, entry] of [...cache].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      hash.update(JSON.stringify([file, String(entry.size), String(entry.mtimeNs), String(entry.ctimeNs)]));
    }
    hash.update('|');
  }
  return hash.digest('hex');
}

if (parentPort) {
  const fileCache = new Map();
  const scriptCache = new Map();
  let previous = '';
  let queue = Promise.resolve();
  parentPort.on('message', ({ id }) => {
    queue = queue.then(async () => {
      const result = await collectLocalisationKeys(workerData.repository, fileCache, scriptCache);
      const signature = keyIndexInputSignature(result, fileCache, scriptCache);
      const unchanged = signature === previous;
      previous = signature;
      parentPort.postMessage(unchanged ? { id, unchanged: true } : { id, result });
    }).catch((error) => parentPort.postMessage({ id, error: error.message }));
  });
}
