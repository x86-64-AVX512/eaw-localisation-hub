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
  send: (message: { type: 'recoveryDiscard' | 'recoveryIssue' | 'recoveryConfirm'; recoveryCode?: string }) => void;
  showToast: (message: string, isError?: boolean) => void;
}

function safeFileName(value: string | undefined): string {
  const name = String(value ?? 'user').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim();
  return `EaW-Hub-Recovery-${name || 'user'}.txt`;
}

function recoveryFile(user: string | undefined, code: string): string {
  return [
    'EaW Localisation Hub – код восстановления', '',
    `Пользователь: ${user}`, `Код: ${code}`, '',
    'Храните этот файл отдельно и не отправляйте его другим людям.',
    'Код одноразовый: после восстановления пароля потребуется новый.',
    'Администратор и сервер не могут показать этот код повторно.', '',
  ].join('\r\n');
}

export function createRecoveryBanner({ state, send, showToast }: RecoveryBannerOptions) {
  const banner = requiredElement<HTMLElement>('#recovery-banner');
  const message = requiredElement<HTMLElement>('#recovery-message');
  const action = requiredElement<HTMLButtonElement>('#recovery-action');
  let saving = false;

  function refresh() {
    const status = state.recoveryStatus;
    banner.hidden = status === 'active' || !status;
    action.hidden = status === 'admin_authorization_required';
    action.disabled = saving;
    if (status === 'setup_required') {
      message.textContent = 'У аккаунта нет сохранённого кода восстановления.';
      action.textContent = 'Получить и сохранить';
    } else if (status === 'pending_confirmation') {
      message.textContent = 'Сохранение кода не было подтверждено. Несохранённый код необходимо аннулировать.';
      action.textContent = 'Аннулировать код';
    } else if (status === 'admin_authorization_required') {
      message.textContent = 'Код восстановления использован или сброшен. Обратитесь к администратору за разрешением на новый.';
    } else if (status === 'issuance_authorized') {
      message.textContent = 'Администратор разрешил выдачу нового кода восстановления.';
      action.textContent = 'Получить и сохранить';
    }
  }

  action.addEventListener('click', () => {
    if (state.recoveryStatus === 'pending_confirmation') send({ type: 'recoveryDiscard' });
    else if (typeof window.showSaveFilePicker !== 'function') {
      showToast('Системный диалог сохранения недоступен. Обновите Microsoft Edge WebView2 Runtime.', true);
    } else {
      saving = true;
      refresh();
      send({ type: 'recoveryIssue' });
    }
  });

  async function save(code: string): Promise<void> {
    try {
      const picker = window.showSaveFilePicker;
      if (!picker) throw new Error('Системный диалог сохранения недоступен.');
      const handle = await picker({
        suggestedName: safeFileName(state.user),
        types: [{ description: 'Текстовый файл', accept: { 'text/plain': ['.txt'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(recoveryFile(state.user, code));
      await writable.close();
      send({ type: 'recoveryConfirm', recoveryCode: code });
    } catch {
      send({ type: 'recoveryDiscard' });
      showToast('Код не сохранён и был аннулирован. Попробуйте ещё раз.', true);
    } finally {
      saving = false;
      refresh();
    }
  }

  return { refresh, save };
}
