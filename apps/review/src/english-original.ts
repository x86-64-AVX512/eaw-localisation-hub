import { uiText } from '../../../packages/shared/src/ui-language.mts';
interface CursorEditor {
  getModel(): { getLineContent(line: number): string } | null;
  getPosition(): { lineNumber: number } | null;
}

interface EnglishOriginalOptions {
  state: { ticket?: { id?: string } | null };
  editor: CursorEditor;
  token: string;
  showToast: (message: string, isError?: boolean) => void;
  onOpened?: (pair: string) => void;
}

export function keyAtCursor(editor: CursorEditor): string {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return '';
  const line = model.getLineContent(position.lineNumber);
  const match = /^\s*([^#\s][^:]*?):(?:\d+)?\s/u.exec(line);
  return match?.[1]?.trim() ?? '';
}

export function createEnglishOriginal(options: EnglishOriginalOptions): void {
  const { state, editor, token, showToast, onOpened = () => {} } = options;
  const button = document.querySelector<HTMLButtonElement>('#english-original');
  if (!button) throw new Error(uiText("Не найдена кнопка английского оригинала."));

  button.addEventListener('click', async () => {
    const key = keyAtCursor(editor);
    if (!key) {
      showToast(uiText("Поставьте курсор на строку с ключом локализации."), true);
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
      const payload: unknown = await response.json().catch(() => ({}));
      const result = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `HTTP ${response.status}`);
      onOpened(pair);
      showToast(uiText("Английский файл открыт: {0}:{1}", result.file, result.line));
    } catch (error) {
      showToast(uiText("Не удалось открыть оригинал: {0}", error instanceof Error ? error.message : String(error)), true);
    } finally {
      button.disabled = false;
    }
  });
}
