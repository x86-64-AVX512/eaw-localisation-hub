import { decodeBase64 } from './review-utilities.js';

export function createDocumentVariants({
  state, editor, send, showToast, beforeChange, afterChange, onChanged,
}) {
  const selector = document.querySelector('#document-view');
  const openButton = document.querySelector('#personal-file-open');
  const dialog = document.querySelector('#personal-file-dialog');
  const message = document.querySelector('#personal-file-message');
  const conflictsElement = document.createElement('div');
  conflictsElement.className = 'personal-git-conflicts';
  message.after(conflictsElement);

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
  }

  selector.addEventListener('change', () => select(selector.value));
  openButton.addEventListener('click', () => dialog.showModal());
  document.querySelector('#personal-file-git').addEventListener('click', () => {
    if (!window.confirm('Записать в рабочий файл чистую версию Git HEAD? Совместный документ не изменится.')) return;
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
      ? `Рабочий файл изолирован от чужих изменений. Конфликтующих ключей: ${conflictCount}.`
      : 'Рабочий файл содержит только Git и ваши изменения; совместная версия хранится отдельно.';
    dialog.classList.toggle('has-conflicts', conflictCount > 0 || gitConflicts.length > 0);
    openButton.classList.toggle('has-conflicts', conflictCount > 0 || gitConflicts.length > 0);
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

  return { update, updateAuthor, status, select };
}
