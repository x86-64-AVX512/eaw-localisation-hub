import { uiText, uiLocale } from '../../../packages/shared/src/ui-language.mts';
import { canEditDocument } from '../../../packages/shared/src/document-permissions.mts';
import type * as Monaco from 'monaco-editor';
import { createStandardDiffView } from './standard-diff-view.ts';
import { confirmAction } from './confirm-action.ts';
import { requiredElement } from './dom-elements.ts';

export interface HistoryEntry {
  id: string;
  reason: string;
  author: string;
  suggestionAuthor?: string;
  color?: string;
  createdAt: string;
  updatedAt?: string;
}
interface HistoryState {
  path: string;
  roles?: string[];
  relativePath?: string;
  history: HistoryEntry[];
  historyHeadId: string;
  ticket?: { status?: string } | null;
}
type HistoryCommand =
  | { type: 'historyRequest'; path: string; id: string }
  | { type: 'historyRestore'; path: string; id: string; headId: string };

const reasonLabels: Record<string, string> = {
  baseline: uiText("Исходное состояние"), edit: uiText("Редактирование"), suggestion: uiText("Принята правка"), restore: uiText("Восстановление"),
};
export { createGitHistoryPanel } from './git-history-panel.ts';

export function historyEntryLabels(entry: HistoryEntry): { primary: string; secondary: string; selection: string } {
  const reason = reasonLabels[entry.reason] ?? entry.reason;
  if (entry.reason !== 'suggestion') {
    return { primary: entry.author, secondary: reason, selection: `${entry.author} · ${reason}` };
  }
  const creator = entry.suggestionAuthor ?? entry.author;
  const accepter = entry.suggestionAuthor ? entry.author : uiText("не записано");
  return {
    primary: uiText("Создал: {0}", creator),
    secondary: uiText("Принял: {0} · {1}", accepter, reason),
    selection: uiText("Создал: {0} · Принял: {1} · {2}", creator, accepter, reason),
  };
}

export function createHistoryPanel({ monaco, state, send, showToast }: {
  monaco: typeof Monaco;
  state: HistoryState;
  editor?: unknown;
  send: (message: HistoryCommand) => void;
  showToast: (message: string) => void;
}) {
  const button = requiredElement<HTMLButtonElement>('#history-open');
  const dialog = requiredElement<HTMLDialogElement>('#history-dialog');
  const list = requiredElement<HTMLElement>('#history-list');
  const empty = requiredElement<HTMLElement>('#history-empty');
  const restore = requiredElement<HTMLButtonElement>('#history-restore');
  const selectionLabel = requiredElement<HTMLElement>('#history-selection');
  const diffView = createStandardDiffView({
    monaco, container: requiredElement<HTMLElement>('#history-diff'),
  });
  diffView.setActive(false);
  let selectedId = '';
  let previousId = '';

  function suspendHistory() {
    selectedId = '';
    previousId = '';
    diffView.setActive(false);
  }

  function closeHistory() {
    suspendHistory();
    if (dialog.open) dialog.close();
  }

  function render() {
    list.replaceChildren();
    empty.hidden = state.history.length > 0;
    button.disabled = state.history.length === 0;
    for (const entry of state.history) {
      const labels = historyEntryLabels(entry);
      const item = document.createElement('button');
      item.className = `history-item${entry.reason === 'suggestion' ? ' suggestion-attribution' : ''}${entry.id === selectedId ? ' selected' : ''}`;
      item.style.setProperty('--history-color', entry.color || '#8a8a8a');
      const date = new Date(entry.updatedAt || entry.createdAt);
      item.innerHTML = `<strong></strong><span></span><small></small>`;
      const primary = requiredElement<HTMLElement>('strong', item);
      const secondary = requiredElement<HTMLElement>('span', item);
      primary.textContent = labels.primary;
      secondary.textContent = labels.secondary;
      primary.title = labels.primary;
      secondary.title = labels.secondary;
      requiredElement<HTMLElement>('small', item).textContent = Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(uiLocale());
      item.addEventListener('click', () => select(entry));
      list.append(item);
    }
  }

  function select(entry: HistoryEntry): void {
    const labels = historyEntryLabels(entry);
    selectedId = entry.id;
    const index = state.history.findIndex((item) => item.id === entry.id);
    previousId = state.history[index + 1]?.id ?? '';
    diffView.clear();
    restore.disabled = !canEditDocument(state, state.relativePath ?? '') || entry.id === state.historyHeadId || ['applied', 'closed'].includes(state.ticket?.status ?? '');
    selectionLabel.textContent = labels.selection;
    send({ type: 'historyRequest', path: state.path, id: entry.id });
    if (previousId) send({ type: 'historyRequest', path: state.path, id: previousId });
    render();
  }

  function receiveVersion(message: { id: string; textBase64: string }): void {
    if (!dialog.open || (message.id !== selectedId && message.id !== previousId)) return;
    const binary = atob(message.textBase64);
    const value = new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    if (message.id === selectedId) diffView.setModified(value);
    else diffView.setOriginal(value);
  }

  button.addEventListener('click', () => {
    selectedId = '';
    previousId = '';
    diffView.clear();
    selectionLabel.textContent = uiText("Выберите версию слева");
    restore.disabled = true;
    render();
    dialog.showModal();
    diffView.setActive(true);
  });
  restore.addEventListener('click', async () => {
    if (!selectedId || !canEditDocument(state, state.relativePath ?? '')) return;
    const entry = state.history.find((item) => item.id === selectedId);
    const date = entry ? new Date(entry.updatedAt || entry.createdAt).toLocaleString(uiLocale()) : '';
    const id = selectedId, headId = state.historyHeadId;
    if (!await confirmAction(restore, uiText("Применить версию от {0}? Текущее состояние останется в истории.", date), { label: uiText("Применить") }) || selectedId !== id) return;
    send({ type: 'historyRestore', path: state.path, id, headId });
    closeHistory();
    showToast(uiText("Запрошено восстановление версии…"));
  });
  requiredElement<HTMLButtonElement>('#history-close').addEventListener('click', closeHistory);
  dialog.addEventListener('close', suspendHistory);

  return {
    update(entries: HistoryEntry[], headId: string) {
      state.history = entries;
      state.historyHeadId = headId;
      if (selectedId && !entries.some((entry) => entry.id === selectedId)) {
        selectedId = '';
        restore.disabled = true;
        selectionLabel.textContent = uiText("Документ изменился – выберите версию заново");
      }
      render();
    },
    receiveVersion,
    dispose() { diffView.dispose(); },
  };
}
