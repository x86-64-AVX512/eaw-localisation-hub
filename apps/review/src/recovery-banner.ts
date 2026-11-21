import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { requiredElement } from './dom-elements.ts';

interface RecoveryFileHandle {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<RecoveryFileHandle>;
  }
}

interface RecoveryBannerOptions {
  state: { recoveryStatus?: string; user?: string };
  send: (message: { type: 'recoveryDiscard' | 'recoveryIssue' | 'recoveryConfirm'; recoveryCode?: string }) => boolean;
  showToast: (message: string, isError?: boolean) => void;
}

function safeFileName(value: string | undefined): string {
  const name = String(value ?? 'user').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim();
  return `EaW-Hub-Recovery-${name || 'user'}.txt`;
}

function recoveryFile(user: string | undefined, code: string): string {
  return [
    uiText("EaW Localisation Hub – код восстановления"), '',
    uiText("Пользователь: {0}", user), uiText("Код: {0}", code), '',
    uiText("Храните этот файл отдельно и не отправляйте его другим людям."),
    uiText("Код одноразовый: после восстановления пароля потребуется новый."),
    uiText("Администратор и сервер не могут показать этот код повторно."), '',
  ].join('\r\n');
}

export function createRecoveryBanner({ state, send, showToast }: RecoveryBannerOptions) {
  const banner = requiredElement<HTMLElement>('#recovery-banner');
  const message = requiredElement<HTMLElement>('#recovery-message');
  const action = requiredElement<HTMLButtonElement>('#recovery-action');
  let busy: 'issue' | 'write' | 'confirm' | null = null;
  let code = '';
  let written = false;

  function refresh() {
    const status = state.recoveryStatus;
    if (status !== 'pending_confirmation') {
      code = '';
      written = false;
      if (busy !== 'issue' || status === 'active') busy = null;
    }
    banner.hidden = status === 'active' || !status;
    action.hidden = status === 'admin_authorization_required';
    action.disabled = busy !== null;
    if (status === 'setup_required') {
      message.textContent = uiText("У аккаунта нет сохранённого кода восстановления.");
      action.textContent = uiText("Получить код");
    } else if (status === 'pending_confirmation') {
      if (code) {
        message.textContent = written
          ? uiText("Файл сохранён. Подтвердите сохранение кода на сервере.")
          : uiText("Код получен. Сохраните его в файл.");
        action.textContent = written ? uiText("Подтвердить сохранение") : uiText("Сохранить код");
      } else {
        message.textContent = uiText("Сохранение кода не было подтверждено. Несохранённый код необходимо аннулировать.");
        action.textContent = uiText("Аннулировать код");
      }
    } else if (status === 'admin_authorization_required') {
      message.textContent = uiText("Код восстановления использован или сброшен. Обратитесь к администратору за разрешением на новый.");
    } else if (status === 'issuance_authorized') {
      message.textContent = uiText("Администратор разрешил выдачу нового кода восстановления.");
      action.textContent = uiText("Получить код");
    }
  }

  function retry() {
    if (busy !== 'write') busy = null;
    refresh();
  }

  function confirm() {
    busy = 'confirm';
    if (!send({ type: 'recoveryConfirm', recoveryCode: code })) {
      retry();
      showToast(uiText("Не удалось подтвердить сохранение кода восстановления."), true);
    }
    refresh();
  }

  action.addEventListener('click', async () => {
    if (busy) return;
    if (state.recoveryStatus === 'pending_confirmation' && !code) {
      send({ type: 'recoveryDiscard' });
      return;
    }
    if (written) {
      confirm();
      return;
    }
    if (!window.showSaveFilePicker) {
      showToast(uiText("Системный диалог сохранения недоступен. Обновите Microsoft Edge WebView2 Runtime."), true);
      return;
    }
    if (!code) {
      busy = 'issue';
      if (!send({ type: 'recoveryIssue' })) {
        retry();
        showToast(uiText("Desktop Agent отключён – ожидается автоматическое переподключение…"), true);
      }
      refresh();
      return;
    }
    const recoveryCode = code;
    const contents = recoveryFile(state.user, recoveryCode);
    busy = 'write';
    refresh();
    try {
      const destination = await window.showSaveFilePicker({
        suggestedName: safeFileName(state.user),
        types: [{ description: uiText("Текстовый файл"), accept: { 'text/plain': ['.txt'] } }],
      });
      if (code !== recoveryCode) return;
      const writable = await destination.createWritable();
      await writable.write(contents);
      await writable.close();
      if (code !== recoveryCode) return;
      written = true;
      confirm();
    } catch (error) {
      busy = null;
      refresh();
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        showToast(uiText("Не удалось записать код восстановления. Попробуйте сохранить его снова."), true);
      }
    }
  });

  function receive(recoveryCode: string) {
    code = recoveryCode;
    written = false;
    busy = null;
    refresh();
  }

  function handleError(message: string) {
    if (message === 'Не удалось выпустить код восстановления.'
      || message === 'Не удалось подтвердить сохранение кода восстановления.') retry();
  }

  return { refresh, receive, retry, handleError, hasDraft: () => Boolean(code || busy) };
}
