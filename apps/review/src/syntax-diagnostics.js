const MARKER_OWNER = 'eaw-localisation-syntax';

export function diagnosticsToMarkers(monaco, model, diagnostics) {
  return diagnostics.map((issue) => ({
    code: issue.code,
    source: 'Синтаксис локализации',
    severity: issue.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    message: issue.message,
    startLineNumber: issue.lineNumber, endLineNumber: issue.lineNumber,
    startColumn: issue.startColumn, endColumn: issue.endColumn,
    ...(issue.related ? { relatedInformation: [{
      resource: model.uri,
      message: 'Первое объявление ключа',
      startLineNumber: issue.related.lineNumber, endLineNumber: issue.related.lineNumber,
      startColumn: issue.related.startColumn, endColumn: issue.related.endColumn,
    }] } : {}),
  }));
}

export function createSyntaxDiagnostics({ monaco, editor, showToast }) {
  const worker = new Worker('/syntax-worker.js', { type: 'module' });
  const button = document.querySelector('#syntax-problems-open');
  const count = document.querySelector('#syntax-problems-count');
  const dialog = document.querySelector('#syntax-problems-dialog');
  const list = document.querySelector('#syntax-problems-list');
  const empty = document.querySelector('#syntax-problems-empty');
  let timer = null; let revision = 0; let issues = []; let failed = false;
  let markedModel = null; let markerSignature = '';

  function jumpTo(lineNumber, column) {
    dialog.close();
    editor.revealLineInCenter(lineNumber);
    editor.setPosition({ lineNumber, column });
    editor.focus();
  }

  function renderList() {
    list.replaceChildren();
    empty.hidden = issues.length > 0;
    for (const issue of issues) {
      const row = document.createElement('div');
      row.className = `syntax-problem ${issue.severity}`;
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = `Строка ${issue.lineNumber}: ${issue.message}`;
      jump.addEventListener('click', () => jumpTo(issue.lineNumber, issue.startColumn));
      row.append(jump);
      if (issue.related) {
        const first = document.createElement('button');
        first.type = 'button'; first.className = 'syntax-related';
        first.textContent = `Первое объявление: строка ${issue.related.lineNumber}`;
        first.addEventListener('click', () => jumpTo(issue.related.lineNumber, issue.related.startColumn));
        row.append(first);
      }
      list.append(row);
    }
  }

  function publish(model, diagnostics) {
    issues = diagnostics;
    const nextSignature = JSON.stringify(diagnostics);
    if (markedModel !== model || markerSignature !== nextSignature) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, diagnosticsToMarkers(monaco, model, issues));
      markedModel = model;
      markerSignature = nextSignature;
    }
    count.textContent = String(issues.length);
    button.hidden = issues.length === 0;
    if (dialog.open) renderList();
  }

  worker.onmessage = ({ data }) => {
    if (data.id !== revision) return;
    const model = editor.getModel();
    if (!model || model.getVersionId() !== data.version) return;
    if (data.error) {
      if (!failed) showToast(`Проверка синтаксиса недоступна: ${data.error}`, true);
      failed = true;
      return;
    }
    failed = false;
    publish(model, data.diagnostics);
  };
  worker.onerror = () => {
    if (!failed) showToast('Фоновая проверка синтаксиса завершилась с ошибкой.', true);
    failed = true;
  };

  function schedule() {
    clearTimeout(timer);
    revision += 1;
    const id = revision;
    timer = setTimeout(() => {
      const model = editor.getModel();
      if (!model || id !== revision) return;
      worker.postMessage({ id, version: model.getVersionId(), text: model.getValue() });
    }, 180);
  }

  const content = editor.onDidChangeModelContent(schedule);
  const modelChange = editor.onDidChangeModel(() => {
    if (markedModel) monaco.editor.setModelMarkers(markedModel, MARKER_OWNER, []);
    markedModel = null; markerSignature = ''; issues = []; count.textContent = '0'; button.hidden = true;
    if (dialog.open) renderList();
    schedule();
  });
  button.addEventListener('click', () => { renderList(); dialog.showModal(); });
  document.querySelector('#syntax-problems-close').addEventListener('click', () => dialog.close());
  schedule();

  return { dispose() {
    clearTimeout(timer); worker.terminate(); content.dispose(); modelChange.dispose();
    if (markedModel) monaco.editor.setModelMarkers(markedModel, MARKER_OWNER, []);
  } };
}
