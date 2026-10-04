import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { workbenchPanelSettings } from '../apps/review/src/appbar-layout.ts';
import { setUiLanguage, uiText } from '../packages/shared/src/ui-language.mts';

test('workbench panel preferences accept only explicit booleans and tolerate corrupt storage', () => {
  for (const value of [null,undefined,[],false,'false',10]) assert.deepEqual(workbenchPanelSettings(value),{});
  assert.deepEqual(workbenchPanelSettings({collaboration:false,discussions:true}),{collaboration:false,discussions:true});
  assert.deepEqual(workbenchPanelSettings({collaboration:'false',discussions:1,unexpected:true}),{collaboration:undefined,discussions:undefined});
});

test('secondary Monaco diff views retain the selected global editor theme', () => {
  for (const name of ['standard-diff-view.ts','git-conflict-diff.ts','ticket-panel.ts']) {
    const source = fs.readFileSync(new URL(`../apps/review/src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /theme\s*:\s*['"]vs-dark['"]/u, `${name} must not reset the user theme`);
  }
});

test('English workbench menu context distinguishes Edit from a suggestion', () => {
  try {
    setUiLanguage('en');
    assert.equal(uiText('Меню «Правка»'),'Edit');
    assert.equal(uiText('Правка'),'Suggestion');
    assert.equal(uiText('Строка {0}, столбец {1}',42,7),'Ln 42, Col 7');
    for (const source of ['Главное меню','Вид','Открыть файл…','Закрыть вкладку','Отменить','Повторить',
      'Участники и брони','Скрыть панель участников','Скрыть панель обсуждений']) assert.notEqual(uiText(source),source);
  } finally { setUiLanguage('ru'); }
});
