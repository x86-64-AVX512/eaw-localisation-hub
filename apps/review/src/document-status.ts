import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { canEditDocument } from '../../../packages/shared/src/document-permissions.mts';

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
  roles?: string[];
  relativePath?: string;
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
  if (!branchNotice || !filesNotice || !fileBlock) throw new Error(uiText("Не найдены элементы состояния документа."));
  const gitRelated = ['git-branch-outdated', 'git-file-outdated', 'git-conflict', 'git-branch-deleted', 'git-unavailable', 'git-branch-merged'].includes(message.status);
  const blocked = ['git-file-outdated', 'git-conflict', 'git-branch-deleted', 'git-unavailable', 'git-branch-merged'].includes(message.status);
  const reason = message.reason === 'local-file-not-in-head'
    ? uiText("Файл отсутствует в локальном HEAD или ещё не был добавлен в Git.")
    : message.reason === 'file-blob-differs'
      ? uiText("Git-содержимое этого файла отличается от канонической версии сервера.") : '';
  branchNotice.hidden = !gitRelated;
  branchNotice.textContent = message.status === 'git-branch-merged'
    ? uiText("Ветка {0} влита в general-dev.", message.branch || state.workspace)
    : message.status === 'git-branch-deleted'
    ? uiText("Ветка {0} удалена без подтверждённого слияния с general-dev.", message.branch || state.workspace)
    : message.status === 'git-unavailable'
      ? uiText("Канонический Git временно недоступен.")
      : gitRelated
        ? uiText("В ветке {0} появился новый коммит. Обновите репозиторий через GitHub Desktop.", message.branch || state.workspace) : '';
  const changedFiles = Array.isArray(message.changedFiles) ? message.changedFiles : [];
  filesNotice.hidden = !gitRelated || changedFiles.length === 0;
  filesNotice.textContent = changedFiles.length
    ? uiText("В новом коммите изменены файлы локализации: {0}", changedFiles.join(', ')) : '';
  fileBlock.hidden = !blocked;
  fileBlock.textContent = message.status === 'git-conflict'
    ? uiText("Новый Git-коммит конфликтует с совместными изменениями этого файла. Редактирование заблокировано до разрешения конфликта.")
    : message.status === 'git-branch-merged'
      ? uiText("Комментарии и тикеты перенесены в general-dev. Переключите локальный Git на general-dev.")
    : message.status === 'git-branch-deleted'
      ? uiText("Комната и тикеты сохранены. Восстановите ветку или перенесите работу после проверки слияния.")
      : message.status === 'git-unavailable'
        ? uiText("Связь с каноническим Git потеряна. Редактирование возобновится после восстановления связи.")
    : blocked
      ? uiText("На этот файл вышел новый коммит. Редактирование заблокировано – обновите репозиторий через GitHub Desktop.")
      : '';
  if (blocked && reason) fileBlock.textContent += ` ${reason}`;
  if (blocked) editor.updateOptions({ readOnly: true });
  else if (['online', 'git-branch-outdated'].includes(message.status) && state.ready) {
    editor.updateOptions({ readOnly: ['applied', 'closed'].includes(state.ticket?.status ?? '')
      || !canEditDocument(state, state.relativePath ?? '') });
  }
  setStatus(message.status === 'online'
    ? uiText("Совместный документ подключён")
    : message.status === 'git-branch-outdated'
      ? uiText("Доступен новый Git-коммит; текущий файл можно редактировать")
      : blocked ? uiText("Git-версия этого файла не актуальна; обновите её в GitHub Desktop")
        : message.status === 'file-unavailable' ? (message.message || uiText("Файл отсутствует в текущей ветке"))
          : message.status === 'offline' ? uiText("Сервер недоступен – Agent продолжит переподключение")
            : message.status === 'unauthorized' ? uiText("Сервер отклонил авторизацию")
              : uiText("Синхронизация…"));
}
