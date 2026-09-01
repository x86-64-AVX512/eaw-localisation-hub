function safeFileName(value) {
  const name = String(value ?? 'user').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim();
  return `EaW-Hub-Recovery-${name || 'user'}.txt`;
}

function recoveryFile(user, code) {
  return [
    'EaW Localisation Hub — код восстановления', '',
    `Пользователь: ${user}`, `Код: ${code}`, '',
    'Храните этот файл отдельно и не отправляйте его другим людям.',
    'Код одноразовый: после восстановления пароля потребуется новый.',
    'Администратор и сервер не могут показать этот код повторно.', '',
  ].join('\r\n');
}

export function createRecoveryBanner({ state, send, showToast }) {
  const banner = document.querySelector('#recovery-banner');
  const message = document.querySelector('#recovery-message');
  const action = document.querySelector('#recovery-action');
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

  async function save(code) {
    try {
      const handle = await window.showSaveFilePicker({
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
