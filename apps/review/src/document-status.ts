interface DocumentStatusMessage {
  status: string;
  reason?: string;
  branch?: string;
  changedFiles?: string[];
  message?: string;
}

interface DocumentStatusState {
  workspace: string;
  ready: boolean;
  ticket?: { status?: string } | null;
}

export function applyDocumentStatus(
  message: DocumentStatusMessage,
  state: DocumentStatusState,
  editor: { updateOptions: (options: { readOnly: boolean }) => void },
  setStatus: (status: string) => void,
): void {
  const branchNotice = document.querySelector<HTMLElement>('#git-branch-notice');
  const filesNotice = document.querySelector<HTMLElement>('#git-files-notice');
  const fileBlock = document.querySelector<HTMLElement>('#git-file-block');
  if (!branchNotice || !filesNotice || !fileBlock) throw new Error('Не найдены элементы состояния документа.');
  const gitRelated = ['git-branch-outdated', 'git-file-outdated', 'git-conflict', 'git-branch-deleted', 'git-unavailable', 'git-branch-merged'].includes(message.status);
  const blocked = ['git-file-outdated', 'git-conflict', 'git-branch-deleted', 'git-unavailable', 'git-branch-merged'].includes(message.status);
  const reason = message.reason === 'local-file-not-in-head'
    ? 'Файл отсутствует в локальном HEAD или ещё не был добавлен в Git.'
    : message.reason === 'file-blob-differs'
      ? 'Git-содержимое этого файла отличается от канонической версии сервера.' : '';
  branchNotice.hidden = !gitRelated;
  branchNotice.textContent = message.status === 'git-branch-merged'
    ? `Ветка ${message.branch || state.workspace} влита в general-dev.`
    : message.status === 'git-branch-deleted'
    ? `Ветка ${message.branch || state.workspace} удалена без подтверждённого слияния с general-dev.`
    : message.status === 'git-unavailable'
      ? 'Канонический Git временно недоступен.'
      : gitRelated
        ? `В ветке ${message.branch || state.workspace} появился новый коммит. Обновите репозиторий через GitHub Desktop.` : '';
  const changedFiles = Array.isArray(message.changedFiles) ? message.changedFiles : [];
  filesNotice.hidden = !gitRelated || changedFiles.length === 0;
  filesNotice.textContent = changedFiles.length
    ? `В новом коммите изменены файлы локализации: ${changedFiles.join(', ')}` : '';
  fileBlock.hidden = !blocked;
  fileBlock.textContent = message.status === 'git-conflict'
    ? 'Новый Git-коммит конфликтует с совместными изменениями этого файла. Редактирование заблокировано до разрешения конфликта.'
    : message.status === 'git-branch-merged'
      ? 'Комментарии и тикеты перенесены в general-dev. Переключите локальный Git на general-dev.'
    : message.status === 'git-branch-deleted'
      ? 'Комната и тикеты сохранены. Восстановите ветку или перенесите работу после проверки слияния.'
      : message.status === 'git-unavailable'
        ? 'Связь с каноническим Git потеряна. Редактирование возобновится после восстановления связи.'
    : blocked
      ? 'На этот файл вышел новый коммит. Редактирование заблокировано – обновите репозиторий через GitHub Desktop.'
      : '';
  if (blocked && reason) fileBlock.textContent += ` ${reason}`;
  if (blocked) editor.updateOptions({ readOnly: true });
  else if (['online', 'git-branch-outdated'].includes(message.status) && state.ready) {
    editor.updateOptions({ readOnly: ['applied', 'closed'].includes(state.ticket?.status ?? '') });
  }
  setStatus(message.status === 'online'
    ? 'Совместный документ подключён'
    : message.status === 'git-branch-outdated'
      ? 'Доступен новый Git-коммит; текущий файл можно редактировать'
      : blocked ? 'Git-версия этого файла не актуальна; обновите её в GitHub Desktop'
        : message.status === 'file-unavailable' ? (message.message || 'Файл отсутствует в текущей ветке')
          : message.status === 'offline' ? 'Сервер недоступен – Agent продолжит переподключение'
            : message.status === 'unauthorized' ? 'Сервер отклонил авторизацию'
              : 'Синхронизация…');
}
