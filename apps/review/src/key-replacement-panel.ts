import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { confirmAction } from './confirm-action.ts';
import { requiredElement } from './dom-elements.ts';

interface ReplacementPreview {
  errors: { line: number; message: string }[];
  duplicateKeys: string[];
  missingKeys: string[];
  duplicateMatches: { key: string; matches: { file: string; line: number }[] }[];
  changes: { key: string; file: string; oldText: string; newText: string }[];
  files: { path: string; hash: string }[];
}
interface ReplacementResult { changedKeys: number; changedFiles: number }

export function createKeyReplacementPanel({ token, state, showToast }: {
  token: string;
  state: { ticket: unknown };
  showToast: (message: string, isError?: boolean) => void;
}) {
  const open = requiredElement<HTMLButtonElement>('#key-replace-open');
  const dialog = requiredElement<HTMLDialogElement>('#key-replace-dialog');
  const input = requiredElement<HTMLTextAreaElement>('#key-replace-input');
  const language = requiredElement<HTMLSelectElement>('#key-replace-language');
  const previewButton = requiredElement<HTMLButtonElement>('#key-replace-preview');
  const applyButton = requiredElement<HTMLButtonElement>('#key-replace-apply');
  const results = requiredElement<HTMLElement>('#key-replace-results');
  let preview: ReplacementPreview | null = null;

  async function request<T>(route: string, body: unknown): Promise<T> {
    const response = await fetch(route, {
      method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => ({}));
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
    return payload as T;
  }

  function render(payload: ReplacementPreview): void {
    results.replaceChildren();
    const problems = [
      ...payload.errors.map((item) => uiText("Строка {0}: {1}", item.line, item.message)),
      ...(payload.duplicateKeys.length ? [uiText("Повторяющиеся ключи во вводе: {0}", payload.duplicateKeys.join(', '))] : []),
      ...(payload.missingKeys.length ? [uiText("Ключи не найдены: {0}", payload.missingKeys.join(', '))] : []),
      ...payload.duplicateMatches.map((item) => uiText("Замена ключа {0} заблокирована: найдено несколько вхождений ({1}).", item.key, item.matches.map((match) => `${match.file}:${match.line}`).join(', '))),
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
    if (!problems.length && !payload.changes.length) results.textContent = uiText("Фактических изменений нет.");
    applyButton.disabled = problems.length > 0 || payload.files.length === 0;
  }

  open.addEventListener('click', () => {
    if (state.ticket) {
      showToast(uiText("Замена по ключам применяется к основной версии и недоступна внутри тикета."), true);
      return;
    }
    preview = null; results.textContent = uiText("Введите ключи и выполните предпросмотр.");
    applyButton.disabled = true; dialog.showModal(); input.focus();
  });
  input.addEventListener('input', () => { preview = null; applyButton.disabled = true; });
  language.addEventListener('change', () => { preview = null; applyButton.disabled = true; results.textContent = uiText("Область поиска изменена. Выполните предпросмотр заново."); });
  previewButton.addEventListener('click', async () => {
    previewButton.disabled = true;
    try { preview = await request<ReplacementPreview>('/api/key-replacements/preview', { input: input.value, language: language.value }); render(preview); }
    catch (error) { showToast(uiText("Предпросмотр не выполнен: {0}", error instanceof Error ? error.message : String(error)), true); }
    finally { previewButton.disabled = false; }
  });
  applyButton.addEventListener('click', async () => {
    const approvedPreview = preview;
    if (!preview || !await confirmAction(applyButton, uiText("Применить {0} замен в {1} файлах?", preview.changes.length, preview.files.length), { label: uiText("Применить") }) || preview !== approvedPreview) return;
    applyButton.disabled = true;
    try {
      const result = await request<ReplacementResult>('/api/key-replacements/apply', {
        input: input.value, files: preview.files, language: language.value,
      });
      dialog.close(); showToast(uiText("Изменено ключей: {0}; файлов: {1}.", result.changedKeys, result.changedFiles));
    } catch (error) { showToast(uiText("Замена не применена: {0}", error instanceof Error ? error.message : String(error)), true); }
  });
  requiredElement<HTMLButtonElement>('#key-replace-close').addEventListener('click', () => dialog.close());
  return { dispose() {} };
}
