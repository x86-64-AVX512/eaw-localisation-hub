export function applyDocumentStatus(message, state, editor, setStatus) {
  const branchNotice = document.querySelector('#git-branch-notice');
  const filesNotice = document.querySelector('#git-files-notice');
  const fileBlock = document.querySelector('#git-file-block');
  const gitRelated = ['git-branch-outdated', 'git-file-outdated', 'git-conflict'].includes(message.status);
  const blocked = message.status === 'git-file-outdated' || message.status === 'git-conflict';
  const reason = message.reason === 'local-file-not-in-head'
    ? 'Файл отсутствует в локальном HEAD или ещё не был добавлен в Git.'
    : message.reason === 'file-blob-differs'
      ? 'Git-содержимое этого файла отличается от канонической версии сервера.' : '';
  branchNotice.hidden = !gitRelated;
  branchNotice.textContent = gitRelated
    ? `В ветке ${message.branch || state.workspace} появился новый коммит. Обновите репозиторий через GitHub Desktop.` : '';
  const changedFiles = Array.isArray(message.changedFiles) ? message.changedFiles : [];
  filesNotice.hidden = !gitRelated || changedFiles.length === 0;
  filesNotice.textContent = changedFiles.length
    ? `В новом коммите изменены файлы локализации: ${changedFiles.join(', ')}` : '';
  fileBlock.hidden = !blocked;
  fileBlock.textContent = message.status === 'git-conflict'
    ? 'Новый Git-коммит конфликтует с совместными изменениями этого файла. Редактирование заблокировано до разрешения конфликта.'
    : blocked
      ? 'На этот файл вышел новый коммит. Редактирование заблокировано — обновите репозиторий через GitHub Desktop.'
      : '';
  if (blocked && reason) fileBlock.textContent += ` ${reason}`;
  if (blocked) editor.updateOptions({ readOnly: true });
  else if (['online', 'git-branch-outdated'].includes(message.status) && state.ready) {
    editor.updateOptions({ readOnly: ['applied', 'closed'].includes(state.ticket?.status) });
  }
  setStatus(message.status === 'online'
    ? 'Совместный документ подключён'
    : message.status === 'git-branch-outdated'
      ? 'Доступен новый Git-коммит; текущий файл можно редактировать'
      : blocked ? 'Git-версия этого файла не актуальна; обновите её в GitHub Desktop'
        : message.status === 'file-unavailable' ? (message.message || 'Файл отсутствует в текущей ветке')
          : message.status === 'offline' ? 'Сервер недоступен — Agent продолжит переподключение'
            : message.status === 'unauthorized' ? 'Сервер отклонил авторизацию'
              : 'Синхронизация…');
}
