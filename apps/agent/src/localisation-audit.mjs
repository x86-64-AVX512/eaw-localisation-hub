import fs from 'node:fs/promises';
import path from 'node:path';
import { normaliseTrackedPath, withoutUtf8Bom } from '../../../packages/shared/src/text.mjs';

function counterpart(relativePath) {
  const value = relativePath.replaceAll('\\', '/');
  if (value.includes('/russian/')) {
    return value.replace('/russian/', '/english/').replace(/_l_russian(\.ya?ml)$/iu, '_l_english$1');
  }
  if (value.includes('/english/')) {
    return value.replace('/english/', '/russian/').replace(/_l_english(\.ya?ml)$/iu, '_l_russian$1');
  }
  throw new Error('Сверка доступна только для русской и английской локализации.');
}

function entries(text) {
  const result = [];
  for (const [index, line] of text.replaceAll('\r\n', '\n').split('\n').entries()) {
    const match = /^\s*([^#\s][^:]*)\s*:\s*(?:\d+\s*)?"(.*)"\s*(?:#.*)?$/u.exec(line);
    if (!match) continue;
    result.push({ key: match[1].trim(), text: match[2], line: index + 1 });
  }
  return result;
}

function grouped(values) {
  const result = new Map();
  for (const entry of values) {
    if (!result.has(entry.key)) result.set(entry.key, []);
    result.get(entry.key).push(entry);
  }
  return result;
}

function side(group) {
  if (!group?.length) return null;
  return { line: group[0].line, text: group[0].text, count: group.length, occurrences: group };
}

function commentParts(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === '#' && !quoted) {
      return { content: line.slice(0, index), comment: line.slice(index) };
    }
  }
  return { content: line, comment: '' };
}

export function localisationStructure(text) {
  return withoutUtf8Bom(text).replaceAll('\r\n', '\n').split('\n').map((line) => {
    const parts = commentParts(line);
    const content = parts.content.trim();
    const comment = parts.comment.trim();
    if (!content && comment) return `# КОММЕНТАРИЙ ${comment}`;
    if (!content) return '␠ ПУСТАЯ СТРОКА';
    const suffix = comment ? ` ${comment}` : '';
    if (/^l_(?:russian|english)\s*:\s*$/iu.test(content)) {
      return `◆ ЗАГОЛОВОК ЛОКАЛИЗАЦИИ${suffix}`;
    }
    const key = /^([^#\s][^:]*)\s*:/u.exec(content)?.[1]?.trim();
    // Inline comments on localisation entries are informational. They remain
    // visible in Review, but do not make two language structures different.
    if (key) return `КЛЮЧ ${key}`;
    return `⋯ СТРОКА БЕЗ КЛЮЧА${suffix}`;
  });
}

export function localisationDiffText(text) {
  return withoutUtf8Bom(text).replaceAll('\r\n', '\n').split('\n').map((line) => {
    const parts = commentParts(line);
    const content = parts.content.trim();
    const suffix = parts.comment ? `${parts.content.trimEnd() ? ' ' : ''}${parts.comment.trim()}` : '';
    if (!content) return suffix;
    if (/^l_(?:russian|english)\s*:\s*$/iu.test(content)) return `l_localisation:${suffix}`;
    const match = /^(\s*)([^#\s][^:]*?)(\s*:\s*\d*)\s*(?:".*")?\s*$/u.exec(parts.content);
    if (match) return `${match[1]}${match[2].trim()}${match[3]} "…"`;
    return `${parts.content}${suffix}`;
  }).join('\n');
}

export function localisationInlineComments(text) {
  return withoutUtf8Bom(text).replaceAll('\r\n', '\n').split('\n').flatMap((line, index) => {
    const parts = commentParts(line);
    if (!parts.comment) return [];
    const content = parts.content.trim();
    if (/^l_(?:russian|english)\s*:\s*$/iu.test(content)) return [];
    const key = /^([^#\s][^:]*)\s*:/u.exec(content)?.[1]?.trim();
    return key ? [{ line: index + 1, text: parts.comment.trim() }] : [];
  });
}

export async function auditLocalisation(repository, requestedPath) {
  const sourcePath = normaliseTrackedPath(repository, path.resolve(repository, requestedPath));
  const otherPath = counterpart(sourcePath);
  const [source, other] = await Promise.all([
    fs.readFile(path.resolve(repository, sourcePath), 'utf8'),
    fs.readFile(path.resolve(repository, otherPath), 'utf8'),
  ]).catch((error) => { throw new Error(`Не удалось найти парный файл: ${otherPath}. ${error.message}`); });
  const sourceEntries = entries(withoutUtf8Bom(source));
  const otherEntries = entries(withoutUtf8Bom(other));
  const sourceKeys = grouped(sourceEntries);
  const otherKeys = grouped(otherEntries);
  const missingInPair = [...sourceKeys.keys()].filter((key) => !otherKeys.has(key));
  const missingInCurrent = [...otherKeys.keys()].filter((key) => !sourceKeys.has(key));
  const duplicatesCurrent = [...sourceKeys].filter(([, values]) => values.length > 1)
    .map(([key, values]) => ({ key, count: values.length }));
  const duplicatesPair = [...otherKeys].filter(([, values]) => values.length > 1)
    .map(([key, values]) => ({ key, count: values.length }));
  const sourceIsRussian = sourcePath.includes('/russian/');
  const russianPath = sourceIsRussian ? sourcePath : otherPath;
  const englishPath = sourceIsRussian ? otherPath : sourcePath;
  const russianKeys = sourceIsRussian ? sourceKeys : otherKeys;
  const englishKeys = sourceIsRussian ? otherKeys : sourceKeys;
  const russianText = sourceIsRussian ? source : other;
  const englishText = sourceIsRussian ? other : source;
  const russianStructure = localisationStructure(russianText);
  const englishStructure = localisationStructure(englishText);
  const orderedKeys = [...new Set([...russianKeys.keys(), ...englishKeys.keys()])];
  const rows = orderedKeys.map((key) => {
    const russian = side(russianKeys.get(key));
    const english = side(englishKeys.get(key));
    let status = 'ok';
    if (!russian) status = 'missing-russian';
    else if (!english) status = 'missing-english';
    else if (russian.count > 1 || english.count > 1) status = 'duplicate';
    return { key, status, russian, english };
  });
  return {
    currentPath: sourcePath, pairPath: otherPath,
    currentKeyCount: sourceKeys.size, pairKeyCount: otherKeys.size,
    currentLineCount: withoutUtf8Bom(source).split(/\r?\n/u).length,
    pairLineCount: withoutUtf8Bom(other).split(/\r?\n/u).length,
    missingInPair, missingInCurrent, duplicatesCurrent, duplicatesPair,
    russianPath, englishPath,
    russianKeyCount: russianKeys.size, englishKeyCount: englishKeys.size,
    russianLineCount: withoutUtf8Bom(russianText).split(/\r?\n/u).length,
    englishLineCount: withoutUtf8Bom(englishText).split(/\r?\n/u).length,
    structureMatches: russianStructure.length === englishStructure.length
      && russianStructure.every((line, index) => line === englishStructure[index]),
    russianStructureText: russianStructure.join('\n'),
    englishStructureText: englishStructure.join('\n'),
    russianDiffText: localisationDiffText(russianText),
    englishDiffText: localisationDiffText(englishText),
    russianInlineComments: localisationInlineComments(russianText),
    englishInlineComments: localisationInlineComments(englishText),
    rows,
  };
}
