import dictionary from 'dictionary-ru';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  SPELLING_BLOOM_BYTES, addSpellingBloom,
} from '../../../packages/shared/src/spelling-bloom.mjs';

const require = createRequire(import.meta.url);
let payloadPromise = null;

async function buildPayload() {
  const packageRoot = path.dirname(require.resolve('spell-checker-js/package.json'));
  const decoder = new TextDecoder('windows-1251');
  const bloom = new Uint8Array(SPELLING_BLOOM_BYTES);
  let supplementalWordCount = 0;
  for (const name of ['russian.txt', 'russian_surnames.txt']) {
    const source = decoder.decode(await fs.readFile(path.join(packageRoot, 'dictionaries', 'ru', name)));
    for (const word of source.split(/\r?\n/u)) {
      if (!/^[А-ЯЁа-яё]{2,}(?:-[А-ЯЁа-яё]{2,})*$/u.test(word)) continue;
      addSpellingBloom(bloom, word);
      supplementalWordCount += 1;
    }
  }
  return Object.freeze({
    version: 'dictionary-ru@3.0.0+spell-checker-js@1.2.3',
    affBase64: Buffer.from(dictionary.aff).toString('base64'),
    dicBase64: Buffer.from(dictionary.dic).toString('base64'),
    supplementalBloomBase64: Buffer.from(bloom).toString('base64'),
    supplementalWordCount,
  });
}

export function russianDictionaryPayload() {
  if (!payloadPromise) payloadPromise = buildPayload().catch((error) => {
    payloadPromise = null;
    throw error;
  });
  return payloadPromise;
}
