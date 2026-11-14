import { technicalInsertions } from './localisation-markup.mts';
import { parseKeyReplacementBatch } from './localisation-replace.mts';

export const LOCALISATION_AI_MODEL = 'gpt-6-luna';
export const MAX_AI_ENTRIES = 8;
export const MAX_AI_AUTOMATIC_ENTRIES = 64;
export const MAX_AI_REQUEST_CHARS = 12_000;
export const AI_AUTO_INTERVAL_MS = 15_000;

export interface AiEntry {
  key: string;
  text: string;
}
export type ProofreadingLanguage = 'russian' | 'english';
export interface AiRequest { mode: 'review'; language: ProofreadingLanguage; entries: AiEntry[]; automatic?: true }
export interface AiSuggestion { key: string; text: string; reason: string }

const sentenceSegmenters = {
  russian: new Intl.Segmenter('ru', { granularity: 'sentence' }),
  english: new Intl.Segmenter('en', { granularity: 'sentence' }),
};
const languageLetters = { russian: /\p{Script=Cyrillic}/u, english: /\p{Script=Latin}/u };

// Keep offsets aligned with the raw value. Punctuation inside a getter or a
// format code must not become a sentence boundary, and \\n starts a new line.
export function aiSentencesInRange(text: string, start: number, end: number, language: ProofreadingLanguage = 'russian') {
  const parts: string[] = [];
  let offset = 0;
  for (const token of technicalInsertions(text)) {
    parts.push(text.slice(offset, token.start), '0'.repeat(token.end - token.start));
    offset = token.end;
  }
  parts.push(text.slice(offset));
  const visible = parts.join('').replace(/§[^\r\n]|\\[^\r\n]/gu, code => {
    if (/^\\[nN]$/u.test(code)) return '\n\n';
    if (/^\\[tT]$/u.test(code)) return '  ';
    if (code === '\\"') return '\u2060"';
    return '\u2060'.repeat(code.length);
  });
  if (/^[^\S\r\n]+$/u.test(visible.slice(start, end))) {
    start = end = visible.slice(0, start).replace(/[^\S\r\n]+$/u, '').length;
  }
  const result: { start: number; text: string }[] = [];
  for (const { index, segment } of sentenceSegmenters[language].segment(visible)) {
    const from = index + segment.length - segment.trimStart().length;
    const to = index + segment.trimEnd().length;
    if (from >= end && from > start) break;
    if (from >= to) continue;
    if (to < start || (start !== end && to === start)) continue;
    const candidate = visible.slice(from, to);
    if (languageLetters[language].test(candidate)) result.push({ start: from, text: text.slice(from, to) });
  }
  return result;
}

export function aiSentenceAt(text: string, start: number, end: number, language: ProofreadingLanguage = 'russian') {
  return aiSentencesInRange(text, start, end, language).at(-1) ?? null;
}

export const AI_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['suggestions'],
  properties: { suggestions: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['key', 'text', 'reason'],
    properties: { key: { type: 'string' }, text: { type: 'string' }, reason: { type: 'string' } },
  } } },
};

export function aiRequest(value: unknown): AiRequest {
  const input = value as Partial<AiRequest> | null;
  if (!input || input.mode !== 'review') {
    throw new Error('Доступна только проверка орфографии и грамматики.');
  }
  const language = input.language === undefined ? 'russian' : input.language;
  if (language !== 'russian' && language !== 'english') {
    throw new Error('Проверка ИИ доступна для русской и английской локализации.');
  }
  const maximum = input.automatic === true ? MAX_AI_AUTOMATIC_ENTRIES : MAX_AI_ENTRIES;
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > maximum) {
    if (input.automatic === true) throw new Error('Фоновая проверка принимает до 64 фрагментов.');
    throw new Error('Выберите от 1 до 8 ключей локализации.');
  }
  const keys = new Set<string>();
  let size = 0;
  const entries = input.entries.map(entry => {
    if (!entry || typeof entry.key !== 'string' || !/^[^\s:#"]{1,512}$/u.test(entry.key)
      || typeof entry.text !== 'string' || /[\r\n\u0000]/u.test(entry.text) || keys.has(entry.key)) {
      throw new Error('Для ИИ нужны однозначные ключи и однострочные значения.');
    }
    keys.add(entry.key);
    size += entry.key.length + entry.text.length;
    if (size > MAX_AI_REQUEST_CHARS) throw new Error('Для теста ИИ выберите не более 12 000 символов.');
    return { key: entry.key, text: entry.text };
  });
  if (input.automatic === true
    && entries.some(({ text }) => aiSentenceAt(text, 0, text.length, language)?.text !== text)) {
    throw new Error('В каждом элементе фоновой проверки должен быть один фрагмент на выбранном языке.');
  }
  return { mode: 'review', language, entries, ...(input.automatic === true ? { automatic: true } : {}) };
}

function protectedParts(text: string): string {
  const insertions = technicalInsertions(text).map(token => text.slice(token.start, token.end)).sort();
  const formatting = text.match(/§[^\r\n]|\\[^\r\n]/gu) ?? [];
  return JSON.stringify([insertions, formatting]);
}

export function aiSuggestions(value: unknown, request: AiRequest): AiSuggestion[] {
  const suggestions = (value as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(suggestions) || suggestions.length > request.entries.length) {
    throw new Error('ИИ вернул некорректный список предложений.');
  }
  const entries = new Map(request.entries.map(entry => [entry.key, entry]));
  const seen = new Set<string>();
  const result: AiSuggestion[] = [];
  for (const item of suggestions) {
    const original = entries.get(item?.key);
    if (!original || seen.has(item.key) || typeof item.text !== 'string' || item.text.length > 16_000
      || /[\r\n\u0000]/u.test(item.text) || typeof item.reason !== 'string' || item.reason.length > 2000) {
      throw new Error('ИИ вернул некорректное предложение.');
    }
    seen.add(item.key);
    const parsed = parseKeyReplacementBatch(`${item.key}:0 "${item.text}"`);
    if (parsed.errors.length || parsed.entries.length !== 1) throw new Error('Не удалось проверить текст предложения ИИ.');
    const text = parsed.entries[0].text;
    if (protectedParts(text) !== protectedParts(original.text)) {
      throw new Error('Предложение ИИ изменяет технические вставки или форматирование.');
    }
    if (text !== original.text) result.push({ key: item.key, text, reason: item.reason });
  }
  return result;
}

// Compare code points, then return Monaco's UTF-16 offsets. Expand an inflection
// change to the surrounding word so "решили" is marked, rather than just "и".
export function aiCorrectionRange(original: string, corrected: string) {
  if (original === corrected) return null;
  const before = [...original];
  const after = [...corrected];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = before.length;
  let afterEnd = after.length;
  while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) {
    end -= 1;
    afterEnd -= 1;
  }
  const word = (character: string) => /^[\p{L}\p{N}\p{M}_]$/u.test(character);
  while (start > 0 && word(before[start - 1])) start -= 1;
  while (end < before.length && afterEnd < after.length && word(before[end]) && before[end] === after[afterEnd]) {
    end += 1;
    afterEnd += 1;
  }
  return { start: before.slice(0, start).join('').length, end: before.slice(0, end).join('').length,
    text: after.slice(start, afterEnd).join('') };
}
