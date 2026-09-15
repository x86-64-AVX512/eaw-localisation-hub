import assert from 'node:assert/strict';
import test from 'node:test';
import nspell from 'nspell';
import dictionary from 'dictionary-ru';
import { spellingIssues } from '../packages/shared/src/spelling-issues.mjs';
import { AuthStore } from '../apps/server/src/auth.mjs';
import { russianDictionaryPayload } from '../apps/server/src/spelling-dictionary.mjs';
import { spellingIssueAtPosition } from '../apps/review/src/spellcheck.js';
import {
  SPELLING_BLOOM_BYTES, addSpellingBloom, hasSpellingBloom,
} from '../packages/shared/src/spelling-bloom.mjs';

const checker = nspell(dictionary);

test('server builds its dictionary without blocking authentication and document sockets', async () => {
  let previousTick = performance.now();
  let maximumPause = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maximumPause = Math.max(maximumPause, now - previousTick);
    previousTick = now;
    ticks += 1;
  }, 20);
  const payload = await russianDictionaryPayload();
  clearInterval(timer);
  assert.ok(ticks >= 5, `main event loop only advanced ${ticks} times while building the dictionary`);
  assert.ok(maximumPause < 500, `dictionary build blocked the main event loop for ${maximumPause} ms`);
  assert.match(payload.version, /^dictionary-ru@/u);
  assert.ok(Buffer.from(payload.affBase64, 'base64').length > 10_000);
  assert.ok(Buffer.from(payload.dicBase64, 'base64').length > 1_000_000);
  assert.equal(Buffer.from(payload.supplementalBloomBase64, 'base64').length, SPELLING_BLOOM_BYTES);
  assert.ok(payload.supplementalWordCount > 2_000_000);
  assert.deepEqual(Object.keys(payload).sort(), [
    'affBase64', 'dicBase64', 'supplementalBloomBase64', 'supplementalWordCount', 'version',
  ]);
});

test('compact supplemental dictionary recognises inserted words', () => {
  const bloom = new Uint8Array(1024);
  addSpellingBloom(bloom, 'Чидхорубанский');
  assert.equal(hasSpellingBloom(bloom, 'чидхорубанский'), true);
  assert.equal(hasSpellingBloom(bloom, 'совершенно-другое'), false);
});

test('Russian spellcheck examines localisation values without touching keys or comments', () => {
  const issues = spellingIssues([
    'l_russian:',
    ' event_key: "Это очивидная ашибка" # камментарий не проверяется',
    ' # ашибка в отдельном комментарии',
  ].join('\n'), checker);
  assert.ok(issues.some(({ word }) => word === 'очивидная'));
  assert.ok(issues.some(({ word }) => word === 'ашибка'));
  assert.ok(!issues.some(({ word }) => word === 'камментарий'));
  assert.ok(!issues.some(({ word }) => word === 'event_key'));
});

test('Russian spellcheck honours the local user dictionary', () => {
  assert.deepEqual(spellingIssues(' key: "Эквестрия"', checker, new Set(['эквестрия'])), []);
});

test('spellcheck offsets a bounded visible fragment without calculating suggestions', () => {
  let checked = 0;
  const issues = spellingIssues(' key: "Ашибка"', { correct() { checked += 1; return false; } }, new Set(), { lineOffset: 99 });
  assert.equal(checked, 1);
  assert.deepEqual(issues, [{ word: 'Ашибка', lineNumber: 100, startColumn: 8, endColumn: 14 }]);
  assert.equal('suggestions' in issues[0], false);
});

test('spellcheck context action belongs only to the underlined word under the pointer', () => {
  const issues = [
    { word: 'Ашибка', lineNumber: 7, startColumn: 10, endColumn: 16 },
  ];
  assert.equal(spellingIssueAtPosition(issues, { lineNumber: 7, column: 12 })?.word, 'Ашибка');
  assert.equal(spellingIssueAtPosition(issues, { lineNumber: 7, column: 9 }), null);
  assert.equal(spellingIssueAtPosition(issues, { lineNumber: 7, column: 16 }), null);
  assert.equal(spellingIssueAtPosition(issues, { lineNumber: 8, column: 12 }), null);
});

test('all authenticated users share additions to the server dictionary', async () => {
  const store = new AuthStore('.', async () => {}, 'required');
  const first = { id: 'translator-1' }; const second = { id: 'translator-2' };
  assert.deepEqual(await store.addSpellingWord(first, 'Эквестрия'), ['эквестрия']);
  assert.deepEqual(await store.addSpellingWord(second, 'Чейнджлинг'), ['эквестрия', 'чейнджлинг']);
  assert.deepEqual(store.spellingWords(first), store.spellingWords(second));
  await assert.rejects(store.addSpellingWord(first, 'not-russian'), { code: 'invalid_word' });
});
