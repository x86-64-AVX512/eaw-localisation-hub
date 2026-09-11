import { createStandardDiffView } from './standard-diff-view.js';
import { confirmAction } from './confirm-action.js';

const reasonLabels = {
  baseline: 'Исходное состояние', edit: 'Редактирование', suggestion: 'Принята правка', restore: 'Восстановление',
};
export { createGitHistoryPanel } from './git-history-panel.js';

export function historyEntryLabels(entry) {
  const reason = reasonLabels[entry.reason] ?? entry.reason;
  if (entry.reason !== 'suggestion') {
    return { primary: entry.author, secondary: reason, selection: `${entry.author} · ${reason}` };
  }
  const creator = entry.suggestionAuthor ?? entry.author;
  const accepter = entry.suggestionAuthor ? entry.author : 'не записано';
  return {
    primary: `Создал: ${creator}`,
    secondary: `Принял: ${accepter} · ${reason}`,
    selection: `Создал: ${creator} · Принял: ${accepter} · ${reason}`,
  };
}

export function createHistoryPanel({ monaco, state, editor, send, showToast }) {
  const button = document.querySelector('#history-open');
  const dialog = document.querySelector('#history-dialog');
  const list = document.querySelector('#history-list');
  const empty = document.querySelector('#history-empty');
  const restore = document.querySelector('#history-restore');
  const selectionLabel = document.querySelector('#history-selection');
  const diffView = createStandardDiffView({
    monaco, container: document.querySelector('#history-diff'),
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
      item.querySelector('strong').textContent = labels.primary;
      item.querySelector('span').textContent = labels.secondary;
      item.querySelector('strong').title = labels.primary;
      item.querySelector('span').title = labels.secondary;
      item.querySelector('small').textContent = Number.isNaN(date.valueOf()) ? '' : date.toLocaleString();
      item.addEventListener('click', () => select(entry));
      list.append(item);
    }
  }

  function select(entry) {
    const labels = historyEntryLabels(entry);
    selectedId = entry.id;
    const index = state.history.findIndex((item) => item.id === entry.id);
    previousId = state.history[index + 1]?.id ?? '';
    diffView.clear();
    restore.disabled = entry.id === state.historyHeadId || ['applied', 'closed'].includes(state.ticket?.status);
    selectionLabel.textContent = labels.selection;
    send({ type: 'historyRequest', path: state.path, id: entry.id });
    if (previousId) send({ type: 'historyRequest', path: state.path, id: previousId });
    render();
  }

  function receiveVersion(message) {
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
    selectionLabel.textContent = 'Выберите версию слева';
    restore.disabled = true;
    render();
    dialog.showModal();
    diffView.setActive(true);
  });
  restore.addEventListener('click', async () => {
    if (!selectedId) return;
    const entry = state.history.find((item) => item.id === selectedId);
    const date = entry ? new Date(entry.updatedAt || entry.createdAt).toLocaleString() : '';
    const id = selectedId, headId = state.historyHeadId;
    if (!await confirmAction(restore, `Применить версию от ${date}? Текущее состояние останется в истории.`, { label: 'Применить' }) || selectedId !== id) return;
    send({ type: 'historyRestore', path: state.path, id, headId });
    closeHistory();
    showToast('Запрошено восстановление версии…');
  });
  document.querySelector('#history-close').addEventListener('click', closeHistory);
  dialog.addEventListener('close', suspendHistory);

  return {
    update(entries, headId) {
      state.history = entries;
      state.historyHeadId = headId;
      if (selectedId && !entries.some((entry) => entry.id === selectedId)) {
        selectedId = '';
        restore.disabled = true;
        selectionLabel.textContent = 'Документ изменился – выберите версию заново';
      }
      render();
    },
    receiveVersion,
    dispose() { diffView.dispose(); },
  };
}
