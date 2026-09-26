import nspell from 'nspell';
import type { NSpellChecker } from 'nspell';
import { spellingIssues } from '../../../packages/shared/src/spelling-issues.mts';
import { hasSpellingBloom } from '../../../packages/shared/src/spelling-bloom.mts';

const MAX_CACHE_ENTRIES = 50_000;
let checker: NSpellChecker | null = null;
let ignoredWords = new Set<string>();
let supplementalBloom: Uint8Array | null = null;
const correctness = new Map<string, boolean>();

type SpellcheckRequest =
  | { id: number; type: 'initialise'; affBase64: string; dicBase64: string;
      supplementalBloomBase64: string; words?: string[] }
  | { id: number; type: 'check'; text: string; lineOffset?: number }
  | { id: number; type: 'suggest'; word: string }
  | { id: number; type: 'words'; words?: string[] };

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBase64Text(value: string): string {
  return new TextDecoder('utf-8').decode(decodeBase64Bytes(value));
}

function cachedChecker() {
  if (!checker || !supplementalBloom) throw new Error('Словарь ещё не загружен');
  const dictionary = checker;
  const bloom = supplementalBloom;
  return {
    correct(word: string): boolean {
      if (!correctness.has(word)) {
        if (correctness.size >= MAX_CACHE_ENTRIES) correctness.clear();
        correctness.set(word, hasSpellingBloom(bloom, word) || dictionary.correct(word));
      }
      return correctness.get(word) ?? false;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

self.onmessage = ({ data }: MessageEvent<SpellcheckRequest>) => {
  const { id, type } = data;
  try {
    let result: { ready: true } | { issues: ReturnType<typeof spellingIssues> } | { suggestions: string[] };
    if (type === 'initialise') {
      checker = nspell({ aff: decodeBase64Text(data.affBase64), dic: decodeBase64Text(data.dicBase64) });
      supplementalBloom = decodeBase64Bytes(data.supplementalBloomBase64);
      ignoredWords = new Set(data.words ?? []);
      correctness.clear();
      result = { ready: true };
    } else if (!checker) throw new Error('Словарь ещё не загружен');
    else if (type === 'check') {
      result = { issues: spellingIssues(data.text, cachedChecker(), ignoredWords, { lineOffset: data.lineOffset }) };
    } else if (type === 'suggest') result = { suggestions: checker.suggest(data.word).slice(0, 6) };
    else if (type === 'words') {
      ignoredWords = new Set(data.words ?? []);
      result = { ready: true };
    } else throw new Error('Неизвестная команда проверки орфографии');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: errorMessage(error) || 'Ошибка проверки орфографии' });
  }
};
