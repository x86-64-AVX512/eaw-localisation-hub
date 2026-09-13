import nspell from 'nspell';
import { spellingIssues } from '../../../packages/shared/src/spelling-issues.mjs';
import { hasSpellingBloom } from '../../../packages/shared/src/spelling-bloom.mjs';

const MAX_CACHE_ENTRIES = 50_000;
let checker = null;
let ignoredWords = new Set();
let supplementalBloom = null;
const correctness = new Map();

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function cachedChecker() {
  return {
    correct(word) {
      if (!correctness.has(word)) {
        if (correctness.size >= MAX_CACHE_ENTRIES) correctness.clear();
        correctness.set(word, hasSpellingBloom(supplementalBloom, word) || checker.correct(word));
      }
      return correctness.get(word);
    },
  };
}

self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    let result;
    if (type === 'initialise') {
      checker = nspell({ aff: decodeBase64(data.affBase64), dic: decodeBase64(data.dicBase64) });
      supplementalBloom = decodeBase64(data.supplementalBloomBase64);
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
    self.postMessage({ id, error: error.message || 'Ошибка проверки орфографии' });
  }
};
