import { createStandardDiffView } from './standard-diff-view.js';

export function createLocalisationAuditPanel({ monaco, state, token, showToast }) {
  const dialog = document.querySelector('#localisation-audit-dialog');
  const results = document.querySelector('#localisation-audit-results');
  const summary = document.querySelector('#localisation-audit-summary');
  const filter = document.querySelector('#localisation-audit-filter');
  const filterLabel = document.querySelector('#localisation-audit-filter-label');
  const view = document.querySelector('#localisation-audit-view');
  const columns = dialog.querySelector('.audit-columns');
  const structureHost = document.querySelector('#localisation-structure-diff');
  const button = document.querySelector('#localisation-audit-open');
  const structureDiff = createStandardDiffView({
    monaco, container: structureHost, language: 'eaw-yaml',
    editorOptions: { renderOverviewRuler: true },
  });
  const originalComments = structureDiff.diff.getOriginalEditor().createDecorationsCollection();
  const modifiedComments = structureDiff.diff.getModifiedEditor().createDecorationsCollection();
  let payload = null;

  function showInlineComments(collection, model, comments) {
    collection.set((comments ?? []).flatMap((item) => {
      const line = Number(item.line);
      if (!Number.isInteger(line) || line < 1 || line > model.getLineCount()) return [];
      const column = model.getLineMaxColumn(line);
      return [{
        range: new monaco.Range(line, column, line, column),
        options: {
          after: { content: ` ${item.text}`, inlineClassName: 'audit-inline-comment' },
        },
      }];
    }));
  }

  function sideCell(side, missingLabel) {
    const cell = document.createElement('div');
    cell.className = `audit-side${side ? '' : ' missing'}`;
    if (!side) { cell.textContent = missingLabel; return cell; }
    for (const occurrence of side.occurrences ?? [side]) {
      const line = document.createElement('span');
      line.className = 'audit-line-number';
      line.textContent = String(occurrence.line);
      const value = document.createElement('span');
      value.className = 'audit-value';
      value.textContent = occurrence.text;
      const occurrenceRow = document.createElement('div');
      occurrenceRow.className = 'audit-occurrence';
      occurrenceRow.append(line, value);
      cell.append(occurrenceRow);
    }
    return cell;
  }

  function visible(row) {
    if (filter.value === 'all') return true;
    if (filter.value === 'problems') return row.status !== 'ok';
    if (filter.value === 'missing') return row.status.startsWith('missing-');
    return row.status === 'duplicate';
  }

  function render() {
    const structural = view.value === 'structure';
    results.hidden = structural;
    columns.hidden = structural;
    filterLabel.hidden = structural;
    structureHost.hidden = !structural;
    if (payload) {
      const counts = `Русский файл – ${payload.russianLineCount} строк; английский – ${payload.englishLineCount} строк.`;
      if (structural) {
        summary.textContent = `Слева русский файл, справа английский. ${counts} ${payload.structureMatches
          ? 'Физические строки, пустые места и порядок ключей совпадают.'
          : 'Структура не совпадает. Красным отмечены удалённые или смещённые строки, зелёным – добавленные.'}`;
        summary.classList.toggle('error', !payload.structureMatches);
        summary.classList.toggle('ok', payload.structureMatches);
        requestAnimationFrame(structureDiff.layout);
        return;
      }
      summary.textContent = `Русский: ${payload.russianPath}. Английский: ${payload.englishPath}. `
        + `Русский файл – ${payload.russianKeyCount} ключей / ${payload.russianLineCount} строк; `
        + `английский – ${payload.englishKeyCount} ключей / ${payload.englishLineCount} строк.`;
      const keysMatch = payload.rows.every((row) => row.status === 'ok');
      summary.classList.toggle('error', !keysMatch);
      summary.classList.toggle('ok', keysMatch);
    }
    results.replaceChildren();
    if (!payload) return;
    const rows = payload.rows.filter(visible);
    for (const row of rows) {
      const item = document.createElement('article');
      item.className = `audit-row ${row.status}`;
      const key = document.createElement('strong');
      key.className = 'audit-key';
      key.textContent = row.key;
      item.append(key, sideCell(row.russian, 'Нет в русском файле'), sideCell(row.english, 'Нет в английском файле'));
      results.append(item);
    }
    if (!rows.length) {
      const empty = document.createElement('p'); empty.className = 'dialog-hint';
      empty.textContent = 'Для выбранного фильтра расхождений нет.'; results.append(empty);
    }
  }

  async function open() {
    button.disabled = true;
    try {
      const query = new URLSearchParams({ path: state.path });
      const response = await fetch(`/api/localisation-audit?${query}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      });
      payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить сверку.');
      structureDiff.setTexts(payload.russianDiffText ?? '', payload.englishDiffText ?? '');
      showInlineComments(originalComments, structureDiff.originalModel, payload.russianInlineComments);
      showInlineComments(modifiedComments, structureDiff.modifiedModel, payload.englishInlineComments);
      view.value = 'keys';
      filter.value = 'problems';
      render();
      dialog.showModal();
      requestAnimationFrame(structureDiff.layout);
    } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
  }
  button.addEventListener('click', open);
  filter.addEventListener('change', render);
  view.addEventListener('change', render);
  document.querySelector('#localisation-audit-close').addEventListener('click', () => dialog.close());
  document.querySelector('#localisation-audit-fullscreen').addEventListener('click', (event) => {
    dialog.classList.toggle('fullscreen');
    event.currentTarget.textContent = dialog.classList.contains('fullscreen') ? 'Обычный размер' : 'На весь экран';
    requestAnimationFrame(structureDiff.layout);
  });
  return { dispose() { originalComments.clear(); modifiedComments.clear(); structureDiff.dispose(); } };
}
