import { replacementLanguageProfile, russianReviewSection } from './key-replacement-language.mts';
import type { IgnoredReplacementEntry } from './key-replacement-language.mts';

const LOCALISATION_PREFIX = /^(\s*)([^#\s][^:]*?)(:(?:\d+)?)(\s+")/u;
export const AMBIGUOUS_QUOTE_MESSAGE = 'Неоднозначные кавычки перед комментарием. Экранируйте внутренние кавычки или уберите кавычки из комментария.';

export interface LocalisationEntry {
  key: string;
  text: string;
  line: number;
  start: number;
  end: number;
}

export interface KeyReplacementEntry {
  key: string;
  text: string;
  line: number;
}

// Shared by pasted input and repository values. Stop at the second candidate:
// scanning every suffix after that would be both unnecessary and expensive.
function localisationValueEnd(content: string, valueStart: number) {
  let closing = -1;
  for (let index = valueStart; index < content.length; index += 1) {
    if (content[index] === '\\') { index += 1; continue; }
    if (content[index] !== '"') continue;
    if (!/^\s*(?:#.*)?$/u.test(content.slice(index + 1))) continue;
    if (closing >= 0) return { closing, ambiguous: true };
    closing = index;
  }
  return { closing, ambiguous: false };
}

function parseLocalisationSourceLine(content: string) {
  const prefix = LOCALISATION_PREFIX.exec(content);
  if (!prefix) return null;
  const valueStart = prefix[0].length;
  const { closing, ambiguous } = localisationValueEnd(content, valueStart);
  if (closing < 0) return null;
  return { key: prefix[2].trim(), text: ambiguous ? '' : content.slice(valueStart, closing),
    valueStart, valueEnd: closing, ambiguous };
}

const ASCII_DOUBLE_QUOTE = '\u0022';

function escapeUnescapedAsciiQuotes(value: string): string {
  let result = '';
  let consecutiveSlashes = 0;
  for (const character of value) {
    if (character === '\\') {
      consecutiveSlashes += 1;
      result += character;
      continue;
    }
    // Paradox values are delimited only by the ASCII quote U+0022. Russian
    // typographic quotes («», „“, and similar characters) are ordinary text.
    if (character === ASCII_DOUBLE_QUOTE && consecutiveSlashes % 2 === 0) result += '\\';
    result += character;
    consecutiveSlashes = 0;
  }
  return result;
}

function parseReplacementLine(raw: unknown, allowComments = false) {
  const line = String(raw).trim();
  const colon = line.indexOf(':');
  if (colon < 1) return null;
  const key = line.slice(0, colon).trim();
  if (!/^[^\s:#"]+$/u.test(key)) return null;
  let remainder = line.slice(colon + 1).trimStart();
  const version = /^\d+/u.exec(remainder)?.[0] ?? '';
  if (version) remainder = remainder.slice(version.length).trimStart();
  if (remainder.length < 2 || !remainder.startsWith('"')) return null;
  if (!allowComments) return remainder.endsWith('"') ? { key, value: remainder.slice(1, -1), comment: false, ambiguous: false } : null;
  const { closing, ambiguous } = localisationValueEnd(remainder, 1);
  if (ambiguous) return { key, value: '', comment: false, ambiguous: true };
  return closing < 0 ? null : { key, value: remainder.slice(1, closing),
    comment: remainder.slice(closing + 1).includes('#'), ambiguous: false };
}

export function parseKeyReplacementBatch(source: unknown, {
  mode = 'classic', language = 'russian',
}: { mode?: unknown; language?: unknown } = {}) {
  if (mode !== 'classic' && mode !== 'language-filtered') throw new Error('Неизвестный режим замены по ключам.');
  if (language !== 'russian' && language !== 'english') throw new Error('Выберите русские или английские файлы локализации.');
  const entries: KeyReplacementEntry[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const duplicateKeys = new Set<string>();
  const seen = new Set<string>();
  const ignoredEntries: IgnoredReplacementEntry[] = [];
  let ignoredComments = 0;
  let section: 'original' | 'translation' | null = null;
  const lines = String(source ?? '').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    if (mode === 'language-filtered' && raw.trimStart().startsWith('#')) {
      ignoredComments += 1;
      if (language === 'russian') section = russianReviewSection(raw) ?? section;
      continue;
    }
    const parsed = parseReplacementLine(raw, mode === 'language-filtered');
    if (!parsed) {
      errors.push({ line: index + 1, message: 'Ожидается запись вида key:0 "текст" или key: "текст".' });
      continue;
    }
    if (parsed.ambiguous) {
      errors.push({ line: index + 1, message: AMBIGUOUS_QUOTE_MESSAGE });
      continue;
    }
    const key = parsed.key;
    if (mode === 'language-filtered') {
      if (parsed.comment) ignoredComments += 1;
      const profile = replacementLanguageProfile(parsed.value);
      const original = language === 'russian' && section === 'original' && profile.language === 'english';
      if (original || (profile.language !== 'neutral' && profile.language !== language)) {
        ignoredEntries.push({ key, line: index + 1, reason: original ? 'original-section' : 'language', ...profile });
        continue;
      }
    }
    const text = escapeUnescapedAsciiQuotes(parsed.value);
    const roundTrip = parseReplacementLine(`${key}:0 "${text}"`);
    if (!roundTrip || roundTrip.ambiguous || escapeUnescapedAsciiQuotes(roundTrip.value) !== text) {
      errors.push({ line: index + 1, message: 'Значение не удалось безопасно разобрать и собрать обратно.' });
      continue;
    }
    if (seen.has(key)) duplicateKeys.add(key);
    seen.add(key);
    entries.push({ key, text, line: index + 1 });
  }
  const result = { entries, errors, duplicateKeys: [...duplicateKeys] };
  return mode === 'language-filtered' ? { ...result, ignoredEntries, ignoredComments } : result;
}

export function scanLocalisationEntries(text: unknown) {
  const entries: LocalisationEntry[] = [];
  const ambiguousEntries: Array<{ key: string; line: number }> = [];
  let offset = 0;
  let lineNumber = 0;
  for (const line of String(text).split(/(?<=\n)/u)) {
    lineNumber += 1;
    const ending = line.endsWith('\n') ? '\n' : '';
    const content = ending ? line.slice(0, -1).replace(/\r$/u, '') : line;
    const parsed = parseLocalisationSourceLine(content);
    if (parsed?.ambiguous) {
      ambiguousEntries.push({ key: parsed.key, line: lineNumber });
    } else if (parsed) {
      const valueStart = offset + parsed.valueStart;
      entries.push({
        key: parsed.key, text: parsed.text, line: lineNumber, start: valueStart,
        end: offset + parsed.valueEnd,
      });
    }
    offset += line.length;
  }
  return { entries, ambiguousEntries };
}

export function localisationEntries(text: unknown): LocalisationEntry[] {
  return scanLocalisationEntries(text).entries;
}

export function replaceLocalisationValues(text: unknown, replacements: Iterable<[string, string]>) {
  const wanted = replacements instanceof Map ? replacements : new Map(replacements);
  const scanned = scanLocalisationEntries(text);
  const ambiguous = scanned.ambiguousEntries.find(entry => wanted.has(entry.key));
  if (ambiguous) throw new Error(`Неоднозначные кавычки в целевом значении ключа ${ambiguous.key}, строка ${ambiguous.line}.`);
  const matches = scanned.entries.filter((entry) => wanted.has(entry.key));
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.key)) {
      throw new Error(`Ключ ${match.key} встречается в файле несколько раз; замена по имени запрещена.`);
    }
    seen.add(match.key);
  }
  let result = String(text);
  for (const match of matches.toReversed()) {
    result = `${result.slice(0, match.start)}${wanted.get(match.key)}${result.slice(match.end)}`;
  }
  return { text: result, matches };
}
