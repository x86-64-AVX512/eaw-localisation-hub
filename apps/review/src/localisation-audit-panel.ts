import type * as Monaco from 'monaco-editor';
import { createStandardDiffView } from './standard-diff-view.ts';
import { requiredElement } from './dom-elements.ts';

interface AuditOccurrence { line: number; text: string }
interface AuditSide extends AuditOccurrence { occurrences?: AuditOccurrence[] }
interface AuditRow {
  key: string;
  status: string;
  russian: AuditSide | null;
  english: AuditSide | null;
}
interface AuditPayload {
  russianLineCount: number;
  englishLineCount: number;
  structureMatches: boolean;
  russianPath: string;
  englishPath: string;
  russianKeyCount: number;
  englishKeyCount: number;
  russianDiffText?: string;
  englishDiffText?: string;
  russianInlineComments?: AuditOccurrence[];
  englishInlineComments?: AuditOccurrence[];
  rows: AuditRow[];
}

export function createLocalisationAuditPanel({ monaco, state, token, showToast }: {
  monaco: typeof Monaco;
  state: { path: string };
  token: string;
  showToast: (message: string, isError?: boolean) => void;
}) {
  const dialog = requiredElement<HTMLDialogElement>('#localisation-audit-dialog');
  const results = requiredElement<HTMLElement>('#localisation-audit-results');
  const summary = requiredElement<HTMLElement>('#localisation-audit-summary');
  const filter = requiredElement<HTMLSelectElement>('#localisation-audit-filter');
  const filterLabel = requiredElement<HTMLElement>('#localisation-audit-filter-label');
  const view = requiredElement<HTMLSelectElement>('#localisation-audit-view');
  const columns = requiredElement<HTMLElement>('.audit-columns', dialog);
  const structureHost = requiredElement<HTMLElement>('#localisation-structure-diff');
  const button = requiredElement<HTMLButtonElement>('#localisation-audit-open');
  const structureDiff = createStandardDiffView({
    monaco, container: structureHost, language: 'eaw-yaml',
    editorOptions: { renderOverviewRuler: true },
  });
  const originalComments = structureDiff.diff.getOriginalEditor().createDecorationsCollection();
  const modifiedComments = structureDiff.diff.getModifiedEditor().createDecorationsCollection();
  let payload: AuditPayload | null = null;

  function showInlineComments(collection: Monaco.editor.IEditorDecorationsCollection,
    model: Monaco.editor.ITextModel, comments: AuditOccurrence[] | undefined): void {
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

  function sideCell(side: AuditSide | null, missingLabel: string): HTMLDivElement {
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

  function visible(row: AuditRow): boolean {
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
      const responsePayload: unknown = await response.json();
      if (!response.ok) {
        const error = responsePayload && typeof responsePayload === 'object'
          ? (responsePayload as Record<string, unknown>).error : null;
        throw new Error(typeof error === 'string' ? error : 'Не удалось выполнить сверку.');
      }
      payload = responsePayload as AuditPayload;
      structureDiff.setTexts(payload.russianDiffText ?? '', payload.englishDiffText ?? '');
      showInlineComments(originalComments, structureDiff.originalModel, payload.russianInlineComments);
      showInlineComments(modifiedComments, structureDiff.modifiedModel, payload.englishInlineComments);
      view.value = 'keys';
      filter.value = 'problems';
      render();
      dialog.showModal();
      requestAnimationFrame(structureDiff.layout);
    } catch (error) { showToast(error instanceof Error ? error.message : String(error), true); } finally { button.disabled = false; }
  }
  button.addEventListener('click', open);
  filter.addEventListener('change', render);
  view.addEventListener('change', render);
  requiredElement<HTMLButtonElement>('#localisation-audit-close').addEventListener('click', () => dialog.close());
  const fullscreen = requiredElement<HTMLButtonElement>('#localisation-audit-fullscreen');
  fullscreen.addEventListener('click', () => {
    dialog.classList.toggle('fullscreen');
    fullscreen.textContent = dialog.classList.contains('fullscreen') ? 'Обычный размер' : 'На весь экран';
    requestAnimationFrame(structureDiff.layout);
  });
  return { dispose() { originalComments.clear(); modifiedComments.clear(); structureDiff.dispose(); } };
}
