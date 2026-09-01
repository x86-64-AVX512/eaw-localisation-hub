import path from 'node:path';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { TRACKED_PATH_PATTERN } from './constants.mjs';

const execFileAsync = promisify(execFile);
const lineEndingPreferenceCache = new Map();

export function clearTrackedLineEndingPreferences() {
  lineEndingPreferenceCache.clear();
}

export function withoutUtf8Bom(text) {
  const value = String(text ?? '');
  return value.startsWith('\uFEFF') ? value.slice(1) : value;
}

export function withUtf8Bom(text) {
  return `\uFEFF${withoutUtf8Bom(text)}`;
}

export function normaliseLineEndings(text) {
  return String(text ?? '').replace(/\r\n?|\n/gu, '\n');
}

function dominantLineEnding(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\r' && value[index + 1] === '\n') {
      crlf += 1;
      index += 1;
    } else if (value[index] === '\n') {
      lf += 1;
    } else if (value[index] === '\r') {
      cr += 1;
    }
  }
  if (crlf === 0 && lf === 0 && cr === 0) return '';
  if (crlf >= lf && crlf >= cr) return '\r\n';
  if (cr > lf) return '\r';
  return '\n';
}

export function preserveLineEndings(text, referenceText, preferredEnding = '') {
  const ending = preferredEnding || dominantLineEnding(referenceText);
  if (!ending) return String(text ?? '');
  return normaliseLineEndings(text).replaceAll('\n', ending);
}

async function gitOutput(repositoryRoot, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
      maxBuffer: 64 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

async function preferredTrackedLineEnding(repositoryRoot, absolutePath, currentText) {
  const currentEnding = dominantLineEnding(currentText);
  if (currentEnding && currentEnding !== '\n') return currentEnding;
  const relativePath = path.relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
  const cacheKey = `${path.resolve(repositoryRoot)}\0${relativePath}`;
  const cached = lineEndingPreferenceCache.get(cacheKey);
  if (cached) return cached;
  const preference = (async () => {
    const attributes = await gitOutput(repositoryRoot, [
      'check-attr', '-z', 'eol', 'text', '--', relativePath,
    ]);
    const fields = attributes.split('\0');
    const values = new Map();
    for (let index = 0; index + 2 < fields.length; index += 3) {
      values.set(fields[index + 1], fields[index + 2]);
    }
    if (values.get('eol') === 'crlf') return '\r\n';
    if (values.get('eol') === 'lf') return '\n';
    if (!['set', 'auto'].includes(values.get('text'))) return currentEnding;
    const autoCrlf = (await gitOutput(repositoryRoot, ['config', '--get', 'core.autocrlf']))
      .trim().toLowerCase();
    if (autoCrlf === 'true') return '\r\n';
    if (autoCrlf === 'input') return '\n';
    const coreEol = (await gitOutput(repositoryRoot, ['config', '--get', 'core.eol']))
      .trim().toLowerCase();
    if (coreEol === 'crlf') return '\r\n';
    if (coreEol === 'lf') return '\n';
    return os.EOL;
  })();
  lineEndingPreferenceCache.set(cacheKey, preference);
  return preference;
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
}

export function utf8ByteOffsetToUtf16Index(text, byteOffset) {
  assertInteger(byteOffset, 'byteOffset');
  const total = Buffer.byteLength(text, 'utf8');
  if (byteOffset < 0 || byteOffset > total) {
    throw new RangeError(`UTF-8 byte offset ${byteOffset} is outside 0..${total}`);
  }

  let bytes = 0;
  let index = 0;
  while (index < text.length && bytes < byteOffset) {
    const codePoint = text.codePointAt(index);
    const width16 = codePoint > 0xffff ? 2 : 1;
    const width8 = Buffer.byteLength(String.fromCodePoint(codePoint), 'utf8');
    if (bytes + width8 > byteOffset) {
      throw new RangeError(`UTF-8 byte offset ${byteOffset} splits a code point`);
    }
    bytes += width8;
    index += width16;
  }

  if (bytes !== byteOffset) {
    throw new RangeError(`UTF-8 byte offset ${byteOffset} is not a character boundary`);
  }
  return index;
}

export function utf16IndexToUtf8ByteOffset(text, utf16Index) {
  assertInteger(utf16Index, 'utf16Index');
  if (utf16Index < 0 || utf16Index > text.length) {
    throw new RangeError(`UTF-16 index ${utf16Index} is outside 0..${text.length}`);
  }
  if (
    utf16Index > 0 &&
    utf16Index < text.length &&
    /[\uD800-\uDBFF]/.test(text[utf16Index - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[utf16Index])
  ) {
    throw new RangeError(`UTF-16 index ${utf16Index} splits a surrogate pair`);
  }
  return Buffer.byteLength(text.slice(0, utf16Index), 'utf8');
}

export function applyUtf8ByteEdit(text, positionByte, deleteBytes, insertedText) {
  assertInteger(deleteBytes, 'deleteBytes');
  if (deleteBytes < 0) {
    throw new RangeError('deleteBytes must not be negative');
  }
  const start = utf8ByteOffsetToUtf16Index(text, positionByte);
  const end = utf8ByteOffsetToUtf16Index(text, positionByte + deleteBytes);
  return `${text.slice(0, start)}${insertedText}${text.slice(end)}`;
}

function retreatFromSplitSurrogate(text, index) {
  if (
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/.test(text[index - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[index])
  ) {
    return index - 1;
  }
  return index;
}

export function computeSingleReplace(previous, next) {
  if (previous === next) {
    return null;
  }

  const shortest = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < shortest && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  prefix = Math.min(
    retreatFromSplitSurrogate(previous, prefix),
    retreatFromSplitSurrogate(next, prefix),
  );

  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > prefix &&
    nextEnd > prefix &&
    previous[previousEnd - 1] === next[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  previousEnd = retreatFromSplitSurrogate(previous, previousEnd);
  nextEnd = retreatFromSplitSurrogate(next, nextEnd);

  const removed = previous.slice(prefix, previousEnd);
  const inserted = next.slice(prefix, nextEnd);
  return {
    positionByte: utf16IndexToUtf8ByteOffset(previous, prefix),
    deleteBytes: Buffer.byteLength(removed, 'utf8'),
    insertText: inserted,
  };
}

export function normaliseTrackedPath(repositoryRoot, absolutePath) {
  const { resolvedRoot, resolvedFile, relative } = resolveTrackedPath(repositoryRoot, absolutePath);
  const canonicalRoot = fs.realpathSync.native(resolvedRoot);
  const canonicalFile = fs.realpathSync.native(resolvedFile);
  assertCanonicalContainment(canonicalRoot, canonicalFile, absolutePath);
  return relative;
}

function resolveTrackedPath(repositoryRoot, absolutePath) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const resolvedFile = path.resolve(absolutePath);
  const relative = path.relative(resolvedRoot, resolvedFile).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`File is outside the configured repository: ${absolutePath}`);
  }
  if (!TRACKED_PATH_PATTERN.test(relative)) {
    throw new Error(`File is outside the prototype scope: ${relative}`);
  }
  return { resolvedRoot, resolvedFile, relative };
}

function assertCanonicalContainment(canonicalRoot, canonicalFile, absolutePath) {
  const canonicalRelative = path.relative(canonicalRoot, canonicalFile).replaceAll('\\', '/');
  if (!canonicalRelative || canonicalRelative.startsWith('../') || path.isAbsolute(canonicalRelative)) {
    throw new Error(`File resolves outside the configured repository: ${absolutePath}`);
  }
}

export async function readTrackedTextFile(repositoryRoot, absolutePath) {
  const { resolvedRoot, resolvedFile } = resolveTrackedPath(repositoryRoot, absolutePath);
  let handle;
  try {
    // Open first, then prove that the opened handle still names the canonical file
    // inside the repository. This closes the usual realpath-then-open junction race.
    handle = await fs.promises.open(resolvedFile, 'r');
    const [canonicalRoot, canonicalFile, openedStat] = await Promise.all([
      fs.promises.realpath(resolvedRoot),
      fs.promises.realpath(resolvedFile),
      handle.stat({ bigint: true }),
    ]);
    assertCanonicalContainment(canonicalRoot, canonicalFile, absolutePath);
    const canonicalStat = await fs.promises.stat(canonicalFile, { bigint: true });
    if (openedStat.dev !== canonicalStat.dev || openedStat.ino !== canonicalStat.ino) {
      throw new Error(`File changed identity during secure open: ${absolutePath}`);
    }
    return handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle?.close();
  }
}

export async function writeTrackedTextFile(repositoryRoot, absolutePath, text) {
  const { resolvedRoot, resolvedFile } = resolveTrackedPath(repositoryRoot, absolutePath);
  let handle;
  try {
    handle = await fs.promises.open(resolvedFile, 'r+');
    const [canonicalRoot, canonicalFile, openedStat] = await Promise.all([
      fs.promises.realpath(resolvedRoot),
      fs.promises.realpath(resolvedFile),
      handle.stat({ bigint: true }),
    ]);
    assertCanonicalContainment(canonicalRoot, canonicalFile, absolutePath);
    const canonicalStat = await fs.promises.stat(canonicalFile, { bigint: true });
    if (openedStat.dev !== canonicalStat.dev || openedStat.ino !== canonicalStat.ino) {
      throw new Error(`File changed identity during secure write: ${absolutePath}`);
    }
    const current = await handle.readFile({ encoding: 'utf8' });
    const preferredEnding = await preferredTrackedLineEnding(
      resolvedRoot,
      resolvedFile,
      current,
    );
    const materialised = preserveLineEndings(text, current, preferredEnding);
    if (materialised === current) return false;
    const output = Buffer.from(materialised, 'utf8');
    await handle.truncate(0);
    let offset = 0;
    while (offset < output.length) {
      const { bytesWritten } = await handle.write(output, offset, output.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`Could not write tracked file: ${absolutePath}`);
      offset += bytesWritten;
    }
    await handle.sync();
    return true;
  } finally {
    await handle?.close();
  }
}

export function parseLocalisationKeys(text) {
  const entries = [];
  const expression = /^[ \t]*([^#\s][^:\r\n]*):\d+[ \t]+/gm;
  for (const match of text.matchAll(expression)) {
    entries.push({ key: match[1].trim(), index: match.index });
  }
  return entries;
}

export function keysInsideRange(text, startIndex, endIndex) {
  return parseLocalisationKeys(text)
    .filter(({ index }) => index >= startIndex && index < endIndex)
    .map(({ key }) => key);
}
