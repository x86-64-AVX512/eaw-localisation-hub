import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveUiLanguage, setUiLanguage, uiText, uiMessage } from '../packages/shared/src/ui-language.mts';
import { readUiLanguage, saveUiLanguage } from '../apps/agent/src/ui-language.mjs';

test('UI defaults follow Windows UI language, not region, with explicit overrides', () => {
  for (const culture of ['ru', 'ru-RU', 'RU-ru']) assert.equal(resolveUiLanguage('auto', culture), 'ru');
  for (const culture of ['en-US', 'uk-UA', 'de-DE', '', undefined]) assert.equal(resolveUiLanguage('auto', culture), 'en');
  assert.equal(resolveUiLanguage('en', 'ru-RU'), 'en');
  assert.equal(resolveUiLanguage('ru', 'en-US'), 'ru');
});

test('translations never interpret parameters as messages, markup, or other placeholders', () => {
  const value = 'Русский текст {0} <b> C:\\Тест\\файл.yml';
  try {
    setUiLanguage('en');
    assert.equal(uiText('Закрыть'), 'Close');
    assert.equal(uiText('Роли: {0}', value), `Roles: ${value}`);
    assert.equal(uiMessage(`Роли: ${value}`), `Roles: ${value}`);
    assert.equal(uiMessage('unrecognised system error'), 'unrecognised system error');
    setUiLanguage('ru');
    assert.equal(uiText('Закрыть'), 'Закрыть');
    assert.equal(uiText('Роли: {0}', value), `Роли: ${value}`);
  } finally { setUiLanguage('ru'); }
});

test('English catalog preserves every placeholder and does not contain broken recovery quotes', async () => {
  const catalog = JSON.parse(await fs.readFile(new URL('../packages/shared/locales/en.json', import.meta.url), 'utf8'));
  const tokens = (value) => [...new Set(value.match(/\{\d+(?::[^}]+)?\}/gu) ?? [])].sort();
  for (const [source, translated] of Object.entries(catalog)) {
    assert.equal(typeof translated, 'string', source);
    assert.deepEqual(tokens(translated), tokens(source), source);
  }
  assert.ok(Object.keys(catalog).length > 800);
  assert.equal(Object.keys(catalog).some((key) => key.startsWith('"\nEaW Localisation Hub')), false);
});

test('both UI languages use en dashes and guillemets without altering quoted parameters or YAML examples', async () => {
  const catalog = JSON.parse(await fs.readFile(new URL('../packages/shared/locales/en.json', import.meta.url), 'utf8'));
  for (const [source, translated] of Object.entries(catalog)) {
    assert.doesNotMatch(source, /[\u2014\u201c\u201d\u201e\u201f\u2039\u203a]/u, source);
    assert.doesNotMatch(translated, /[\u2014\u201c\u201d\u201e\u201f\u2039\u203a]/u, source);
  }
  const opaque = 'user \u2014 \u201cunchanged\u201d {0}';
  try {
    for (const language of ['ru', 'en']) {
      setUiLanguage(language);
      const prefix = language === 'en' ? 'ticket' : 'тикет';
      assert.equal(uiText('тикет «{0}»', opaque), `${prefix} «${opaque}»`);
      assert.equal(uiMessage(`тикет «${opaque}»`), `${prefix} «${opaque}»`);
      assert.equal(uiText('EaW Hub – обновление до {0}', '0.8.8F8'),
        language === 'en' ? 'EaW Hub – update to 0.8.8F8' : 'EaW Hub – обновление до 0.8.8F8');
      assert.equal(uiText('key:0 "текст"'), language === 'en' ? 'key:0 "text"' : 'key:0 "текст"');
    }
  } finally { setUiLanguage('ru'); }
});

test('saved manual language preference persists and auto uses current Windows UI language', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-ui-language-'));
  const russian = async () => 'ru-RU';
  const english = async () => 'en-US';
  try {
    assert.equal((await readUiLanguage(directory, russian)).language, 'ru');
    await saveUiLanguage(directory, 'en', russian);
    assert.equal((await readUiLanguage(directory, russian)).language, 'en');
    await saveUiLanguage(directory, 'ru', english);
    assert.equal((await readUiLanguage(directory, english)).language, 'ru');
    await saveUiLanguage(directory, 'auto', english);
    assert.equal((await readUiLanguage(directory, russian)).language, 'ru');
    await assert.rejects(saveUiLanguage(directory, '../en', english));
    assert.equal((await readUiLanguage(directory, english)).preference, 'auto');
    await fs.writeFile(path.join(directory, 'ui-language.json'), '{invalid');
    assert.equal((await readUiLanguage(directory, english)).language, 'en');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
