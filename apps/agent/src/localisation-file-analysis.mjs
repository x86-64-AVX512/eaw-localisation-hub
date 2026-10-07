import fs from 'node:fs/promises';
import path from 'node:path';
import { normaliseTrackedPath } from '../../../packages/shared/src/text.mts';

const MAX_FILE_BYTES = 16 * 1024 * 1024;

export function localisationByteDiagnostics(bytes) {
  const diagnostics = [];
  const report = (code, message) => diagnostics.push({ code, message, severity: 'error',
    lineNumber: 1, startColumn: 1, endColumn: 2 });
  if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) report('disk-missing-utf8-bom',
    'Файл на диске: отсутствует UTF-8 BOM. Загрузчик HOI4 может не прочитать этот файл.');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { report('disk-invalid-utf8', 'Файл на диске: некорректные байты UTF-8. Проверьте кодировку файла.'); }
  return diagnostics;
}

// Byte checks deliberately do not infer encoding from Monaco's BOM-less text
// or rewrite the working file. Secure open mirrors the tracked reader.
export async function inspectLocalisationFile(repository, requestedPath) {
  const absolute = path.resolve(repository, requestedPath);
  const relativePath = normaliseTrackedPath(repository, absolute);
  let handle;
  try {
    handle = await fs.open(absolute, 'r');
    const [root, canonical, opened] = await Promise.all([
      fs.realpath(repository), fs.realpath(absolute), handle.stat({ bigint: true }),
    ]);
    const relative = path.relative(root, canonical);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('File resolves outside the configured repository.');
    }
    const current = await fs.stat(canonical, { bigint: true });
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('File changed identity during secure open.');
    }
    if (opened.size > BigInt(MAX_FILE_BYTES)) throw new Error('Localisation file exceeds the analysis size limit.');
    // A bounded read also limits a concurrently growing file.
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || bytesRead !== Number(opened.size)) throw new Error('File changed during analysis.');
    return { relativePath, diagnostics: localisationByteDiagnostics(bytes.subarray(0, bytesRead)) };
  } finally { await handle?.close(); }
}
