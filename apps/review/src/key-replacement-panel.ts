import { uiText, uiMessage } from '../../../packages/shared/src/ui-language.mts';
import { confirmAction } from './confirm-action.ts';
import { requiredElement } from './dom-elements.ts';
import type { IgnoredReplacementEntry } from '../../../packages/shared/src/key-replacement-language.mts';

interface ReplacementPreview {
  ignoredEntries?: IgnoredReplacementEntry[];
  ignoredComments?: number;
  errors: { line: number; message: string; file?: string; key?: string }[];
  duplicateKeys: string[];
  missingKeys: string[];
  duplicateMatches: { key: string; matches: { file: string; line: number }[] }[];
  changes: { key: string; file: string; oldText: string; newText: string }[];
  files: { path: string; hash: string }[];
}
interface ReplacementResult { changedKeys: number; changedFiles: number }
interface ReplacementSelection { input: string; language: string; mode: string }

export function keyReplacementConfirmation(payload: ReplacementPreview, mode: string): string {
  if (mode !== 'language-filtered') return uiText('Применить {0} замен в {1} файлах?', payload.changes.length, payload.files.length);
  return uiText('Применить {0} замен в {1} файлах? Пропущено значений: {2}. Пустых значений: {3}.',
    payload.changes.length, payload.files.length, payload.ignoredEntries?.length ?? 0,
    payload.changes.filter(change => !change.newText.trim()).length);
}

export function createKeyReplacementPanel({ token, state, showToast }: {
  token: string;
  state: { ticket: unknown };
  showToast: (message: string, isError?: boolean) => void;
}) {
  const open = requiredElement<HTMLButtonElement>('#key-replace-open');
  const dialog = requiredElement<HTMLDialogElement>('#key-replace-dialog');
  const input = requiredElement<HTMLTextAreaElement>('#key-replace-input');
  const language = requiredElement<HTMLSelectElement>('#key-replace-language');
  const mode = requiredElement<HTMLSelectElement>('#key-replace-mode');
  const modeHint = requiredElement<HTMLElement>('#key-replace-mode-hint');
  const previewButton = requiredElement<HTMLButtonElement>('#key-replace-preview');
  const applyButton = requiredElement<HTMLButtonElement>('#key-replace-apply');
  const results = requiredElement<HTMLElement>('#key-replace-results');
  let preview: { data: ReplacementPreview; selection: ReplacementSelection } | null = null;
  let revision = 0;
  let applying = false;

  function invalidate(message?: string): void {
    revision += 1; preview = null; applyButton.disabled = true;
    if (message) results.textContent = message;
  }

  async function request<T>(route: string, body: unknown): Promise<T> {
    const response = await fetch(route, {
      method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => ({}));
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (!response.ok) throw new Error(typeof data.error === 'string' ? uiMessage(data.error) : `HTTP ${response.status}`);
    return payload as T;
  }

  function render(payload: ReplacementPreview): void {
    results.replaceChildren();
    if (payload.ignoredEntries) {
      const summary = document.createElement('p');
      summary.textContent = uiText('Пропущено значений: {0}; комментариев: {1}.', payload.ignoredEntries.length, payload.ignoredComments ?? 0);
      results.append(summary);
      if (payload.ignoredEntries.length) {
        const details = document.createElement('details');
        const heading = document.createElement('summary'); heading.textContent = uiText('Показать пропущенные ключи');
        details.append(heading);
        for (const skipped of payload.ignoredEntries) {
          const item = document.createElement('div'); item.className = 'key-result';
          const reason = skipped.reason === 'original-section' ? uiText('Блок оригинала')
            : uiText('Другой язык: кириллица {0}%, латиница {1}%.', skipped.cyrillicPercent, skipped.latinPercent);
          item.textContent = uiText('Строка {0}: {1} – {2}', skipped.line, skipped.key, reason);
          details.append(item);
        }
        results.append(details);
      }
    }
    const problems = [
      ...payload.errors.map((item) => item.file
        ? uiText('Файл {0}, строка {1}, ключ {2}: {3}', item.file, item.line, item.key ?? '', uiMessage(item.message))
        : uiText("Строка {0}: {1}", item.line, uiMessage(item.message))),
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
    if (!problems.length && !payload.changes.length) {
      const empty = document.createElement('p'); empty.textContent = uiText("Фактических изменений нет."); results.append(empty);
    }
    applyButton.disabled = problems.length > 0 || payload.files.length === 0;
  }

  open.addEventListener('click', () => {
    if (state.ticket) {
      showToast(uiText("Замена по ключам применяется к основной версии и недоступна внутри тикета."), true);
      return;
    }
    if (applying) return;
    invalidate(uiText("Введите ключи и выполните предпросмотр."));
    modeHint.hidden = mode.value !== 'language-filtered';
    dialog.showModal(); input.focus();
  });
  input.addEventListener('input', () => invalidate());
  language.addEventListener('change', () => invalidate(uiText("Область поиска изменена. Выполните предпросмотр заново.")));
  mode.addEventListener('change', () => {
    modeHint.hidden = mode.value !== 'language-filtered';
    invalidate(uiText('Режим изменён. Выполните предпросмотр заново.'));
  });
  previewButton.addEventListener('click', async () => {
    invalidate();
    const requestRevision = revision;
    const selection = { input: input.value, language: language.value, mode: mode.value };
    previewButton.disabled = true;
    try {
      const data = await request<ReplacementPreview>('/api/key-replacements/preview', selection);
      if (requestRevision !== revision) return;
      preview = { data, selection }; render(data);
    } catch (error) {
      if (requestRevision === revision) showToast(uiText("Предпросмотр не выполнен: {0}", error instanceof Error ? error.message : String(error)), true);
    }
    finally { previewButton.disabled = false; }
  });
  applyButton.addEventListener('click', async () => {
    const approvedPreview = preview;
    if (!approvedPreview || applying || !await confirmAction(applyButton, keyReplacementConfirmation(approvedPreview.data, approvedPreview.selection.mode), { label: uiText("Применить") }) || preview !== approvedPreview) return;
    applying = true;
    for (const control of [input, language, mode, previewButton]) control.disabled = true;
    applyButton.disabled = true;
    try {
      const result = await request<ReplacementResult>('/api/key-replacements/apply', {
        ...approvedPreview.selection, files: approvedPreview.data.files,
      });
      invalidate();
      dialog.close(); showToast(uiText("Изменено ключей: {0}; файлов: {1}.", result.changedKeys, result.changedFiles));
    } catch (error) {
      invalidate(); showToast(uiText("Замена не применена: {0}", error instanceof Error ? error.message : String(error)), true);
    } finally {
      applying = false;
      for (const control of [input, language, mode, previewButton]) control.disabled = false;
    }
  });
  requiredElement<HTMLButtonElement>('#key-replace-close').addEventListener('click', () => dialog.close());
  return { dispose() {} };
}
