import { requiredInput } from './dom-elements.ts';
import type * as Monaco from 'monaco-editor';
import type { SpellingIssue } from '../../../packages/shared/src/spelling-issues.mts';

interface SpellcheckOptions {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  token: string;
  showToast: (message: string, isError?: boolean) => void;
}

interface DictionaryPayload {
  affBase64: string;
  dicBase64: string;
  supplementalBloomBase64: string;
}

interface WordsPayload { words: string[] }

interface WorkerReply { id: number; error?: string; result?: unknown }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STORAGE_KEY = 'eaw-hub-spellcheck-v1';
const VIEWPORT_MARGIN = 40;
const MAX_CHECKED_LINES = 240;

function loadEnabled(): boolean {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').enabled !== false; }
  catch { return true; }
}

export function spellingIssueAtPosition(values: Iterable<SpellingIssue>,
  position: Monaco.IPosition | null): SpellingIssue | null {
  if (!position) return null;
  return [...values].find((item) => item.lineNumber === position.lineNumber
    && position.column >= item.startColumn && position.column < item.endColumn) ?? null;
}

export function createSpellcheck({ monaco, editor, token, showToast }: SpellcheckOptions) {
  const enabled = requiredInput('#spellcheck-enabled'); enabled.checked = loadEnabled();
  const worker = new Worker('/spellcheck-worker.js', { type: 'module' });
  const decorations = editor.createDecorationsCollection();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let workerSequence = 0; let initialisePromise: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checkId = 0; let issues = new Map<string, SpellingIssue>(); let lastError = '';
  let started = false;
  let contextIssue: SpellingIssue | null = null;
  let quickFixPanel: HTMLDivElement | null = null;

  async function request<T>(route: string, method = 'GET', body?: object): Promise<T> {
    const response = await fetch(route, {
      method, cache: 'no-store', headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  async function askWorker<T>(type: string, payload: object = {}): Promise<T> {
    const id = ++workerSequence;
    const result = await new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload });
    });
    return result as T;
  }
  worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
    const operation = pending.get(data.id);
    if (!operation) return;
    pending.delete(data.id);
    if (data.error) operation.reject(new Error(data.error)); else operation.resolve(data.result);
  };
  worker.onerror = () => {
    for (const operation of pending.values()) operation.reject(new Error('Фоновая проверка завершилась с ошибкой'));
    pending.clear();
  };

  function initialise(): Promise<unknown> {
    if (!initialisePromise) initialisePromise = Promise.all([
      request<DictionaryPayload>('/api/spelling/dictionary'), request<WordsPayload>('/api/spelling/words'),
    ]).then(([dictionary, shared]) => askWorker<{ ready: true }>('initialise', {
      affBase64: dictionary.affBase64, dicBase64: dictionary.dicBase64,
      supplementalBloomBase64: dictionary.supplementalBloomBase64, words: shared.words,
    })).catch((error) => { initialisePromise = null; throw error; });
    return initialisePromise;
  }

  function clear() {
    issues = new Map(); decorations.clear();
  }
  function reportError(prefix: string, error: unknown): void {
    const message = errorMessage(error);
    if (/HTTP 404|Not found/u.test(message) || message === lastError) return;
    lastError = message;
    showToast(`${prefix}: ${message}`, true);
  }
  async function checkVisibleArea() {
    const id = checkId; const model = editor.getModel();
    if (!model || !enabled.checked) { clear(); return; }
    try {
      await initialise();
      if (id !== checkId || model !== editor.getModel()) return;
      const visibleRanges = editor.getVisibleRanges();
      const anchor = visibleRanges.length
        ? Math.min(...visibleRanges.map(({ startLineNumber }) => startLineNumber))
        : editor.getPosition()?.lineNumber ?? 1;
      const startLineNumber = Math.max(1, anchor - VIEWPORT_MARGIN);
      const visibleEnd = visibleRanges.length
        ? Math.max(...visibleRanges.map(({ endLineNumber }) => endLineNumber)) : anchor;
      const endLineNumber = Math.min(
        model.getLineCount(), visibleEnd + VIEWPORT_MARGIN, startLineNumber + MAX_CHECKED_LINES - 1,
      );
      const version = model.getVersionId();
      const payload = await askWorker<{ issues: SpellingIssue[] }>('check', {
        lineOffset: startLineNumber - 1,
        text: model.getValueInRange({
          startLineNumber, startColumn: 1,
          endLineNumber, endColumn: model.getLineMaxColumn(endLineNumber),
        }),
      });
      if (id !== checkId || version !== model.getVersionId() || model !== editor.getModel()) return;
      lastError = '';
      issues = new Map(payload.issues.map((item) => [
        `${item.lineNumber}:${item.startColumn}:${item.endColumn}`, item,
      ]));
      decorations.set(payload.issues.map((item) => ({
        range: new monaco.Range(
          item.lineNumber, item.startColumn, item.lineNumber, item.endColumn,
        ),
        options: {
          inlineClassName: 'spelling-error',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })));
    } catch (error) {
      if (id === checkId) clear();
      reportError('Проверка орфографии недоступна', error);
    }
  }
  const schedule = () => {
    if (!started) return;
    clearTimeout(timer); checkId += 1;
    timer = setTimeout(checkVisibleArea, 200);
  };
  const content = editor.onDidChangeModelContent(schedule);
  const scrolling = editor.onDidScrollChange((event) => {
    if (!event.scrollTopChanged && !event.scrollHeightChanged) return;
    schedule();
  });
  const runQuickFix = () => editor.trigger('eaw-spelling', 'editor.action.quickFix', {});
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period, runQuickFix);
  const quickFixKey = editor.onKeyDown((event) => {
    const key = event.browserEvent;
    if (!(key.ctrlKey || key.metaKey) || key.altKey || key.key !== '.') return;
    event.preventDefault();
    event.stopPropagation();
    runQuickFix();
  });
  const provider = monaco.languages.registerCodeActionProvider('eaw-yaml', {
    async provideCodeActions(model, range) {
      const actions: Monaco.languages.CodeAction[] = [];
      for (const issue of issues.values()) {
        if (issue.lineNumber < range.startLineNumber || issue.lineNumber > range.endLineNumber) continue;
        if (issue.lineNumber === range.startLineNumber && issue.endColumn < range.startColumn) continue;
        if (issue.lineNumber === range.endLineNumber && issue.startColumn > range.endColumn) continue;
        let payload: { suggestions: string[] } = { suggestions: [] };
        try { await initialise(); payload = await askWorker<{ suggestions: string[] }>('suggest', { word: issue.word }); }
        catch (error) { reportError('Варианты исправления недоступны', error); }
        for (const suggestion of payload.suggestions ?? []) actions.push({
          title: `Заменить на «${suggestion}»`, kind: 'quickfix', isPreferred: actions.length === 0,
          edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: {
            range: new monaco.Range(issue.lineNumber, issue.startColumn, issue.lineNumber, issue.endColumn), text: suggestion,
          } }] },
        });
        actions.push({ title: `Добавить «${issue.word}» в общий словарь сервера`, kind: 'quickfix',
          command: { id: 'eaw.spelling.addWord', title: 'Добавить в словарь', arguments: [issue.word] } });
      }
      return { actions, dispose() {} };
    },
  });
  async function addWord(word: string): Promise<void> {
    try {
      const payload = await request<WordsPayload>('/api/spelling/words', 'PUT', { word });
      await initialise(); await askWorker<{ ready: true }>('words', { words: payload.words }); schedule();
      showToast(`«${word}» добавлено в общий словарь сервера.`);
    } catch (error) { showToast(`Не удалось добавить слово: ${errorMessage(error)}`, true); }
  }
  const command = monaco.editor.registerCommand(
    'eaw.spelling.addWord', async (_accessor, word) => addWord(word),
  );
  function closeQuickFixPanel() {
    if (!quickFixPanel) return;
    quickFixPanel.remove();
    quickFixPanel = null;
    document.removeEventListener('pointerdown', dismissQuickFixPanel, true);
    document.removeEventListener('keydown', dismissQuickFixPanelWithEscape, true);
    window.removeEventListener('resize', closeQuickFixPanel);
  }
  function dismissQuickFixPanel(event: PointerEvent): void {
    if (quickFixPanel && event.target instanceof Node && !quickFixPanel.contains(event.target)) closeQuickFixPanel();
  }
  function dismissQuickFixPanelWithEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeQuickFixPanel();
  }
  function replaceIssue(issue: SpellingIssue, suggestion: string): void {
    const model = editor.getModel();
    if (!model) return;
    const range = new monaco.Range(
      issue.lineNumber, issue.startColumn, issue.lineNumber, issue.endColumn,
    );
    if (model.getValueInRange(range) !== issue.word) {
      closeQuickFixPanel(); schedule(); return;
    }
    editor.pushUndoStop();
    editor.executeEdits('eaw-spelling-quick-fix', [{ range, text: suggestion }]);
    editor.pushUndoStop();
    closeQuickFixPanel();
    editor.focus();
  }
  async function openQuickFixPanel(issue: SpellingIssue): Promise<void> {
    closeQuickFixPanel();
    const model = editor.getModel();
    if (!model) return;
    let payload: { suggestions: string[] } = { suggestions: [] };
    try { await initialise(); payload = await askWorker<{ suggestions: string[] }>('suggest', { word: issue.word }); }
    catch (error) { reportError('Варианты исправления недоступны', error); }
    const range = new monaco.Range(
      issue.lineNumber, issue.startColumn, issue.lineNumber, issue.endColumn,
    );
    if (model !== editor.getModel() || model.getValueInRange(range) !== issue.word) return;

    const panel = document.createElement('div');
    panel.className = 'spelling-quick-fix-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', `Быстрые исправления для ${issue.word}`);
    const heading = document.createElement('strong');
    heading.textContent = `Исправить «${issue.word}»`;
    panel.append(heading);
    const suggestions = [...new Set(payload.suggestions ?? [])].slice(0, 8);
    if (suggestions.length) {
      for (const suggestion of suggestions) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = suggestion; button.setAttribute('role', 'menuitem');
        button.addEventListener('click', () => replaceIssue(issue, suggestion));
        panel.append(button);
      }
    } else {
      const empty = document.createElement('span');
      empty.className = 'spelling-quick-fix-empty';
      empty.textContent = 'Подходящих вариантов замены нет.';
      panel.append(empty);
    }
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'spelling-quick-fix-add';
    add.textContent = 'Добавить в общий словарь'; add.setAttribute('role', 'menuitem');
    add.addEventListener('click', () => { closeQuickFixPanel(); addWord(issue.word); });
    panel.append(add);
    document.body.append(panel);
    quickFixPanel = panel;

    const editorRect = editor.getDomNode()?.getBoundingClientRect();
    const position = editor.getScrolledVisiblePosition({
      lineNumber: issue.lineNumber, column: issue.startColumn,
    });
    if (!editorRect || !position) { closeQuickFixPanel(); return; }
    const left = Math.max(8, Math.min(
      editorRect.left + position.left, window.innerWidth - panel.offsetWidth - 8,
    ));
    const top = Math.max(8, Math.min(
      editorRect.top + position.top + position.height, window.innerHeight - panel.offsetHeight - 8,
    ));
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
    document.addEventListener('pointerdown', dismissQuickFixPanel, true);
    document.addEventListener('keydown', dismissQuickFixPanelWithEscape, true);
    window.addEventListener('resize', closeQuickFixPanel);
    panel.querySelector('button')?.focus();
  }
  const contextKey = editor.createContextKey<boolean>('eawSpellingIssueAtContextMenu', false);
  const rightClick = editor.onMouseDown((event) => {
    if (!event.event.rightButton) return;
    contextIssue = spellingIssueAtPosition(issues.values(), event.target.position);
    contextKey.set(Boolean(contextIssue));
  });
  const contextAction = editor.addAction({
    id: 'eaw.spelling.addWordFromContext',
    label: 'Добавить слово в общий словарь',
    precondition: 'eawSpellingIssueAtContextMenu',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    run: async () => { if (contextIssue) await addWord(contextIssue.word); },
  });
  const quickFixAction = editor.addAction({
    id: 'eaw.spelling.openQuickFixesFromContext',
    label: 'Открыть быстрые исправления',
    precondition: 'eawSpellingIssueAtContextMenu',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run: () => {
      const issue = contextIssue;
      if (!issue) return;
      openQuickFixPanel(issue);
    },
  });
  enabled.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: enabled.checked }));
    if (enabled.checked) schedule(); else { checkId += 1; clear(); }
  });
  return { start() {
    if (started) return;
    started = true;
    schedule();
  }, refresh: schedule, dispose() {
    clearTimeout(timer); closeQuickFixPanel(); worker.terminate(); pending.clear(); decorations.clear();
    if ('dispose' in decorations && typeof decorations.dispose === 'function') decorations.dispose();
    content.dispose(); scrolling.dispose(); quickFixKey.dispose(); provider.dispose(); command.dispose();
    rightClick.dispose(); contextAction.dispose(); quickFixAction.dispose(); contextKey.reset();
  } };
}
