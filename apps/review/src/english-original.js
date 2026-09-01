function keyAtCursor(editor) {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return '';
  const line = model.getLineContent(position.lineNumber);
  const match = /^\s*([^#\s][^:]*?):\d+\s/u.exec(line);
  return match?.[1]?.trim() ?? '';
}

export function createEnglishOriginal(options) {
  const { state, editor, token, showToast, onOpened = () => {} } = options;
  const button = document.querySelector('#english-original');
  const dialog = document.querySelector('#english-dialog');
  const heading = document.querySelector('#english-heading');
  const results = document.querySelector('#english-results');

  button.addEventListener('click', async () => {
    const key = keyAtCursor(editor);
    if (!key) {
      showToast('Поставьте курсор на строку с ключом локализации.', true);
      return;
    }
    button.disabled = true;
    try {
      const pair = crypto.randomUUID();
      const response = await fetch('/api/english-open', {
        method: 'POST', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, ticket: state.ticket?.id ?? '', pair }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      onOpened(pair);
      showToast(`Английский файл открыт: ${payload.file}:${payload.line}`);
    } catch (error) {
      showToast(`Не удалось открыть оригинал: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
}
