const STORAGE_KEY = 'eaw-hub-spellcheck-v1';
const OWNER = 'eaw-russian-spelling';
const VIEWPORT_MARGIN = 40;
const MAX_CHECKED_LINES = 240;

function loadEnabled() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').enabled !== false; }
  catch { return true; }
}

export function createSpellcheck({ monaco, editor, token, showToast }) {
  const enabled = document.querySelector('#spellcheck-enabled'); enabled.checked = loadEnabled();
  const worker = new Worker('/spellcheck-worker.js', { type: 'module' });
  const pending = new Map();
  let workerSequence = 0; let initialisePromise = null;
  let timer; let checkId = 0; let issues = new Map(); let checkedRange = null; let lastError = '';

  async function request(route, method = 'GET', body) {
    const response = await fetch(route, {
      method, cache: 'no-store', headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function askWorker(type, payload = {}) {
    const id = ++workerSequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload });
    });
  }
  worker.onmessage = ({ data }) => {
    const operation = pending.get(data.id);
    if (!operation) return;
    pending.delete(data.id);
    if (data.error) operation.reject(new Error(data.error)); else operation.resolve(data.result);
  };
  worker.onerror = () => {
    for (const operation of pending.values()) operation.reject(new Error('Фоновая проверка завершилась с ошибкой'));
    pending.clear();
  };

  function initialise() {
    if (!initialisePromise) initialisePromise = Promise.all([
      request('/api/spelling/dictionary'), request('/api/spelling/words'),
    ]).then(([dictionary, shared]) => askWorker('initialise', {
      affBase64: dictionary.affBase64, dicBase64: dictionary.dicBase64,
      supplementalBloomBase64: dictionary.supplementalBloomBase64, words: shared.words,
    })).catch((error) => { initialisePromise = null; throw error; });
    return initialisePromise;
  }

  function clear() {
    issues = new Map(); checkedRange = null; const model = editor.getModel();
    if (model) monaco.editor.setModelMarkers(model, OWNER, []);
  }
  function reportError(prefix, error) {
    if (/HTTP 404|Not found/u.test(error.message) || error.message === lastError) return;
    lastError = error.message;
    showToast(`${prefix}: ${error.message}`, true);
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
      const payload = await askWorker('check', {
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
      checkedRange = { start: startLineNumber, end: endLineNumber };
      monaco.editor.setModelMarkers(model, OWNER, payload.issues.map((item) => ({
        severity: monaco.MarkerSeverity.Info,
        message: `Слово «${item.word}» отсутствует в русском словаре.`,
        source: 'Русская орфография', code: 'eaw-spelling',
        startLineNumber: item.lineNumber, endLineNumber: item.lineNumber,
        startColumn: item.startColumn, endColumn: item.endColumn,
      })));
    } catch (error) {
      if (id === checkId) clear();
      reportError('Проверка орфографии недоступна', error);
    }
  }
  const schedule = () => {
    clearTimeout(timer); checkId += 1;
    timer = setTimeout(checkVisibleArea, 200);
  };
  function viewportIsOutsideCheckedRange() {
    if (!checkedRange) return true;
    const ranges = editor.getVisibleRanges();
    if (!ranges.length) return false;
    const start = Math.min(...ranges.map(({ startLineNumber }) => startLineNumber));
    const end = Math.max(...ranges.map(({ endLineNumber }) => endLineNumber));
    return start < checkedRange.start || end > checkedRange.end;
  }
  const content = editor.onDidChangeModelContent(() => { clear(); schedule(); });
  const scrolling = editor.onDidScrollChange((event) => {
    if (!event.scrollTopChanged && !event.scrollHeightChanged) return;
    if (viewportIsOutsideCheckedRange()) clear();
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
    async provideCodeActions(model, _range, context) {
      const actions = [];
      for (const marker of context.markers.filter((item) => {
        const code = typeof item.code === 'string' ? item.code : item.code?.value;
        return item.owner === OWNER || item.source === 'Русская орфография' || code === 'eaw-spelling';
      })) {
        const issue = issues.get(`${marker.startLineNumber}:${marker.startColumn}:${marker.endColumn}`);
        if (!issue) continue;
        let payload = { suggestions: [] };
        try { await initialise(); payload = await askWorker('suggest', { word: issue.word }); }
        catch (error) { reportError('Варианты исправления недоступны', error); }
        for (const suggestion of payload.suggestions ?? []) actions.push({
          title: `Заменить на «${suggestion}»`, kind: 'quickfix', isPreferred: actions.length === 0,
          edit: { edits: [{ resource: model.uri, textEdit: {
            range: new monaco.Range(issue.lineNumber, issue.startColumn, issue.lineNumber, issue.endColumn), text: suggestion,
          } }] },
        });
        actions.push({ title: `Добавить «${issue.word}» в общий словарь сервера`, kind: 'quickfix',
          command: { id: 'eaw.spelling.addWord', title: 'Добавить в словарь', arguments: [issue.word] } });
      }
      return { actions, dispose() {} };
    },
  });
  const command = monaco.editor.registerCommand('eaw.spelling.addWord', async (_accessor, word) => {
    try {
      const payload = await request('/api/spelling/words', 'PUT', { word });
      await initialise(); await askWorker('words', { words: payload.words }); schedule();
      showToast(`«${word}» добавлено в общий словарь сервера.`);
    } catch (error) { showToast(`Не удалось добавить слово: ${error.message}`, true); }
  });
  enabled.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: enabled.checked }));
    if (enabled.checked) schedule(); else { checkId += 1; clear(); }
  });
  schedule();
  return { refresh: schedule, dispose() {
    clearTimeout(timer); worker.terminate(); pending.clear();
    content.dispose(); scrolling.dispose(); quickFixKey.dispose(); provider.dispose(); command.dispose();
  } };
}
