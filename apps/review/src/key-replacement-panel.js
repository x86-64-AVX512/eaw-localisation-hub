export function createKeyReplacementPanel({ token, state, showToast }) {
  const open = document.querySelector('#key-replace-open');
  const dialog = document.querySelector('#key-replace-dialog');
  const input = document.querySelector('#key-replace-input');
  const language = document.querySelector('#key-replace-language');
  const previewButton = document.querySelector('#key-replace-preview');
  const applyButton = document.querySelector('#key-replace-apply');
  const results = document.querySelector('#key-replace-results');
  let preview = null;

  async function request(route, body) {
    const response = await fetch(route, {
      method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function render(payload) {
    results.replaceChildren();
    const problems = [
      ...payload.errors.map((item) => `Строка ${item.line}: ${item.message}`),
      ...(payload.duplicateKeys.length ? [`Повторяющиеся ключи во вводе: ${payload.duplicateKeys.join(', ')}`] : []),
      ...(payload.missingKeys.length ? [`Ключи не найдены: ${payload.missingKeys.join(', ')}`] : []),
      ...payload.duplicateMatches.map((item) => `Ключ ${item.key} найден несколько раз: ${item.matches.map((match) => match.file).join(', ')}`),
    ];
    for (const problem of problems) {
      const item = document.createElement('div'); item.className = 'key-result error'; item.textContent = problem;
      results.append(item);
    }
    for (const change of payload.changes) {
      const item = document.createElement('div'); item.className = 'key-result';
      const title = document.createElement('strong'); title.textContent = `${change.key} · ${change.file}`;
      const values = document.createElement('div'); values.className = 'key-result-diff';
      const before = document.createElement('code'); before.className = 'before';
      before.textContent = `- ${change.key}:0 "${change.oldText}"`;
      const after = document.createElement('code'); after.className = 'after';
      after.textContent = `+ ${change.key}:0 "${change.newText}"`;
      values.append(before, after);
      item.append(title, values); results.append(item);
    }
    if (!problems.length && !payload.changes.length) results.textContent = 'Фактических изменений нет.';
    applyButton.disabled = problems.length > 0 || payload.files.length === 0;
  }

  open.addEventListener('click', () => {
    if (state.ticket) {
      showToast('Замена по ключам применяется к основной версии и недоступна внутри тикета.', true);
      return;
    }
    preview = null; results.textContent = 'Введите ключи и выполните предпросмотр.';
    applyButton.disabled = true; dialog.showModal(); input.focus();
  });
  input.addEventListener('input', () => { preview = null; applyButton.disabled = true; });
  language.addEventListener('change', () => { preview = null; applyButton.disabled = true; results.textContent = 'Область поиска изменена. Выполните предпросмотр заново.'; });
  previewButton.addEventListener('click', async () => {
    previewButton.disabled = true;
    try { preview = await request('/api/key-replacements/preview', { input: input.value, language: language.value }); render(preview); }
    catch (error) { showToast(`Предпросмотр не выполнен: ${error.message}`, true); }
    finally { previewButton.disabled = false; }
  });
  applyButton.addEventListener('click', async () => {
    if (!preview || !confirm(`Применить ${preview.changes.length} замен в ${preview.files.length} файлах?`)) return;
    applyButton.disabled = true;
    try {
      const result = await request('/api/key-replacements/apply', {
        input: input.value, files: preview.files, language: language.value,
      });
      dialog.close(); showToast(`Изменено ключей: ${result.changedKeys}; файлов: ${result.changedFiles}.`);
    } catch (error) { showToast(`Замена не применена: ${error.message}`, true); }
  });
  document.querySelector('#key-replace-close').addEventListener('click', () => dialog.close());
  return { dispose() {} };
}
