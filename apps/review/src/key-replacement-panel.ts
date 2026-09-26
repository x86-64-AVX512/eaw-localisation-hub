import { confirmAction } from './confirm-action.ts';
import { requiredElement } from './dom-elements.ts';

interface ReplacementPreview {
  errors: { line: number; message: string }[];
  duplicateKeys: string[];
  missingKeys: string[];
  duplicateMatches: { key: string; matches: { file: string }[] }[];
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
    try { preview = await request<ReplacementPreview>('/api/key-replacements/preview', { input: input.value, language: language.value }); render(preview); }
    catch (error) { showToast(`Предпросмотр не выполнен: ${error instanceof Error ? error.message : String(error)}`, true); }
    finally { previewButton.disabled = false; }
  });
  applyButton.addEventListener('click', async () => {
    const approvedPreview = preview;
    if (!preview || !await confirmAction(applyButton, `Применить ${preview.changes.length} замен в ${preview.files.length} файлах?`, { label: 'Применить' }) || preview !== approvedPreview) return;
    applyButton.disabled = true;
    try {
      const result = await request<ReplacementResult>('/api/key-replacements/apply', {
        input: input.value, files: preview.files, language: language.value,
      });
      dialog.close(); showToast(`Изменено ключей: ${result.changedKeys}; файлов: ${result.changedFiles}.`);
    } catch (error) { showToast(`Замена не применена: ${error instanceof Error ? error.message : String(error)}`, true); }
  });
  requiredElement<HTMLButtonElement>('#key-replace-close').addEventListener('click', () => dialog.close());
  return { dispose() {} };
}
