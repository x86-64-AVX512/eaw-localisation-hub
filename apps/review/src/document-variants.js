import { decodeBase64 } from './review-utilities.js';
import { confirmAction } from './confirm-action.js';

export function createDocumentVariants({
  monaco, state, editor, send, showToast, beforeChange, afterChange, onChanged,
}) {
  const selector = document.querySelector('#document-view');
  const openButton = document.querySelector('#personal-file-open');
  const dialog = document.querySelector('#personal-file-dialog');
  const message = document.querySelector('#personal-file-message');
  const notice = document.querySelector('#local-file-notice');
  const selectionsElement = document.querySelector('#personal-file-selections');
  const conflictsElement = document.createElement('div');
  conflictsElement.className = 'personal-git-conflicts';
  message.after(conflictsElement);
  const selectionDecorations = editor.createDecorationsCollection();

  function displayLine(value, emptyLabel) {
    return value == null ? `(${emptyLabel})` : value;
  }

  function setSelection(entry, include) {
    if (!state.ready || state.documentView !== 'shared') {
      showToast('Переключитесь на совместную версию и дождитесь подключения.', true);
      return;
    }
    send({ type: 'personalFileSelectionSet', path: state.path,
      changeId: entry.id, include: include ? 1 : 0,
      revision: state.documentVariants?.localSelectionRevision ?? '' });
  }

  function renderSelections() {
    const entries = state.documentVariants?.localSelections ?? [];
    const blocked = state.documentVariants?.localSelectionBlocked ?? '';
    const disabled = Boolean(blocked || state.documentVariants?.gitConflicts.length);
    selectionsElement.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'personal-selection-empty';
      empty.textContent = blocked || 'Совместная версия не отличается от Git HEAD.';
      selectionsElement.append(empty);
    }
    for (const entry of entries) {
      const row = document.createElement('label');
      row.className = `personal-selection-row ${entry.state}`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = entry.state === 'included';
      checkbox.indeterminate = entry.state === 'custom';
      checkbox.disabled = disabled;
      checkbox.addEventListener('change', () => setSelection(entry, checkbox.checked));
      const label = document.createElement('span');
      label.className = 'personal-selection-label';
      label.textContent = entry.kind === 'structure' ? entry.label : `${entry.label} · строка ${entry.lineNumber}`;
      const diff = document.createElement('span');
      diff.className = 'personal-selection-diff';
      const before = document.createElement('del');
      before.textContent = displayLine(entry.gitLine, 'в Git строки нет');
      const after = document.createElement('ins');
      after.textContent = entry.kind === 'structure'
        ? 'Изменена структура, отдельные комментарии или порядок строк'
        : displayLine(entry.sharedLine, 'удалено в совместной версии');
      diff.append(before, after);
      row.append(checkbox, label, diff);
      selectionsElement.append(row);
    }

    const included = entries.filter((entry) => entry.state === 'included').length;
    const custom = entries.filter((entry) => entry.state === 'custom').length;
    notice.hidden = included === 0;
    notice.textContent = included
      ? `В локальный файл включено изменений из совместной версии: ${included}.`
      : '';
    openButton.classList.toggle('has-included', included > 0);
    openButton.textContent = included ? `Локальный файл · ${included}` : 'Локальный файл';
    const decorations = state.documentView === 'shared' && !disabled
      ? entries.filter((entry) => entry.kind !== 'structure').map((entry) => ({
        range: new monaco.Range(entry.lineNumber, 1, entry.lineNumber, 1),
        options: {
          // Keep the glyph anchored to column 1 of the model line. A whole-line
          // decoration is repeated by Monaco for every visual word-wrap row.
          isWholeLine: false,
          glyphMarginClassName: `local-file-check ${entry.state}`,
          glyphMarginHoverMessage: { value: entry.state === 'included'
            ? 'Изменение включено в локальный файл. Нажмите, чтобы вернуть Git-вариант.'
            : entry.state === 'excluded'
              ? 'В локальном файле оставлен Git-вариант. Нажмите, чтобы включить совместный.'
              : 'Локальный вариант отличается и от Git, и от совместного. Нажмите, чтобы включить совместный.' },
        },
      })) : [];
    selectionDecorations.set(decorations);
    if (custom) openButton.title = `Собственных или устаревших локальных вариантов: ${custom}`;
    else openButton.removeAttribute('title');
  }

  const gutterClick = editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    if (!event.target.element?.classList?.contains('local-file-check')) return;
    const lineNumber = event.target.position?.lineNumber;
    const entries = (state.documentVariants?.localSelections ?? [])
      .filter((entry) => entry.lineNumber === lineNumber);
    if (entries.length === 1) setSelection(entries[0], entries[0].state !== 'included');
    else if (entries.length > 1) dialog.showModal();
  });

  function applyText(text) {
    beforeChange();
    state.applyingRemote = true;
    editor.getModel().setValue(text);
    state.applyingRemote = false;
    afterChange();
    onChanged();
  }

  function textFor(view) {
    const variants = state.documentVariants;
    if (!variants) return editor.getValue();
    if (view === 'git') return variants.git;
    if (view === 'mine') return variants.mine;
    if (view.startsWith('author:')) return variants.authors.get(view.slice(7)) ?? variants.shared;
    return variants.shared;
  }

  function select(view) {
    const valid = ['shared', 'mine', 'git'].includes(view) || view.startsWith('author:');
    state.documentView = valid ? view : 'shared';
    selector.value = state.documentView;
    if (state.documentView.startsWith('author:')
      && !state.documentVariants?.authors.has(state.documentView.slice(7))) {
      send({ type: 'documentVariantRequest', path: state.path,
        authorId: state.documentView.slice(7) });
      showToast('Загружается персональная версия участника…');
      return;
    }
    applyText(textFor(state.documentView));
    editor.updateOptions({
      readOnly: !state.ready || state.documentView !== 'shared'
        || ['applied', 'closed'].includes(state.ticket?.status),
    });
    showToast(state.documentView === 'shared'
      ? 'Открыта совместная версия.'
      : state.documentView === 'mine'
        ? 'Предпросмотр Git + только ваши изменения.'
        : state.documentView === 'git' ? 'Предпросмотр чистого Git HEAD.'
          : `Предпросмотр изменений: ${selector.selectedOptions[0]?.textContent ?? 'участник'}.`);
    renderSelections();
  }

  selector.addEventListener('change', () => select(selector.value));
  openButton.addEventListener('click', () => dialog.showModal());
  document.querySelector('#personal-file-git').addEventListener('click', async (event) => {
    if (!await confirmAction(event.currentTarget, 'Записать в рабочий файл чистую версию Git HEAD?', { label: 'Записать' })) return;
    send({ type: 'personalFileMaterialize', path: state.path, mode: 'git' });
    dialog.close();
  });
  document.querySelector('#personal-file-mine').addEventListener('click', () => {
    send({ type: 'personalFileMaterialize', path: state.path, mode: 'mine' });
    dialog.close();
  });

  function update(payload) {
    state.documentVariants = {
      shared: state.reviewDocument?.text() ?? decodeBase64(payload.sharedBase64),
      mine: decodeBase64(payload.mineBase64),
      git: decodeBase64(payload.gitBase64),
      contributors: payload.contributors ?? [],
      conflicts: payload.conflicts ?? [],
      gitConflicts: payload.gitConflicts ?? [],
      localSelections: payload.localSelections ?? [],
      localSelectionBlocked: payload.localSelectionBlocked ?? '',
      localSelectionRevision: payload.localSelectionRevision ?? '',
      authors: new Map(),
    };
    for (const option of [...selector.querySelectorAll('[data-author]')]) option.remove();
    for (const contributor of state.documentVariants.contributors) {
      const option = document.createElement('option');
      option.value = `author:${contributor.id}`;
      option.dataset.author = contributor.id;
      option.textContent = `Изменения: ${contributor.displayName}`;
      selector.append(option);
    }
    selector.value = state.documentView;
    if (state.documentView.startsWith('author:')) select(state.documentView);
    else if (state.documentView !== 'shared') applyText(textFor(state.documentView));
    selector.disabled = false;
    const conflictCount = state.documentVariants.conflicts.length;
    const gitConflicts = state.documentVariants.gitConflicts;
    conflictsElement.replaceChildren();
    for (const conflict of gitConflicts) {
      const row = document.createElement('section');
      const label = document.createElement('h3');
      label.textContent = conflict.label;
      const detail = document.createElement('pre');
      detail.textContent = conflict.reason === 'legacy-base-unknown'
        ? 'У сохранённой версии нет надёжной базы Git. Проверьте версии «Моя» и «Git» перед выбором.'
        : `База: ${conflict.baseLine ?? '(структура или удаление)'}\nМоя: ${conflict.collaborativeLine ?? '(структура или удаление)'}\nGit: ${conflict.externalLine ?? '(структура или удаление)'}`;
      row.append(label, detail);
      for (const [choice, title] of [['mine', 'Оставить мою правку'], ['git', 'Взять Git']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = title;
        button.addEventListener('click', () => {
          send({ type: 'personalConflictResolve', path: state.path, key: conflict.key,
            choice, conflictId: conflict.id });
          for (const control of row.querySelectorAll('button')) control.disabled = true;
        });
        row.append(button);
      }
      conflictsElement.append(row);
    }
    openButton.disabled = false;
    message.textContent = gitConflicts.length
      ? `Запись личной версии приостановлена: конфликтов с Git – ${gitConflicts.length}. Выберите вариант для каждого конфликта.`
      : conflictCount
      ? `Ваши персональные изменения пересекаются с вариантами других участников. Конфликтующих ключей: ${conflictCount}.`
      : 'Рабочий файл содержит только Git и ваши изменения; совместная версия хранится отдельно.';
    dialog.classList.toggle('has-conflicts', conflictCount > 0 || gitConflicts.length > 0);
    openButton.classList.toggle('has-conflicts', conflictCount > 0 || gitConflicts.length > 0);
    renderSelections();
  }

  function updateAuthor(payload) {
    if (!state.documentVariants) return;
    state.documentVariants.authors.set(payload.authorId, decodeBase64(payload.textBase64));
    if (state.documentView === `author:${payload.authorId}`) select(state.documentView);
  }

  function status(payload) {
    message.textContent = payload.message;
    openButton.disabled = false;
    showToast(payload.message);
  }

  return {
    update, updateAuthor, status, select,
    dispose() { gutterClick.dispose(); selectionDecorations.clear(); },
  };
}
