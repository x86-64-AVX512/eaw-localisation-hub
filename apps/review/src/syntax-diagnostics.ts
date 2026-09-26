import type * as Monaco from 'monaco-editor';
import type { LocalisationDiagnostic } from '../../../packages/shared/src/localisation-syntax.mts';
import { requiredElement } from './dom-elements.ts';

const MARKER_OWNER = 'eaw-localisation-syntax';

interface SyntaxDiagnosticsOptions {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  token: string;
  showToast: (message: string, isError?: boolean) => void;
  getFilePath?: (() => string | null) | null;
}

interface SyntaxWorkerResult {
  type?: string;
  id?: number;
  version?: number;
  diagnostics?: LocalisationDiagnostic[];
  error?: string;
}

export function diagnosticsToMarkers(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  diagnostics: LocalisationDiagnostic[],
): Monaco.editor.IMarkerData[] {
  return diagnostics.map((issue) => ({
    code: issue.code,
    source: 'Синтаксис локализации',
    severity: issue.severity === 'error' ? monaco.MarkerSeverity.Error
      : issue.severity === 'info' ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Warning,
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

export function createSyntaxDiagnostics({ monaco, editor, token, showToast, getFilePath = null }: SyntaxDiagnosticsOptions) {
  const worker = new Worker('/syntax-worker.js', { type: 'module' });
  const button = requiredElement<HTMLButtonElement>('#syntax-problems-open');
  const count = requiredElement<HTMLElement>('#syntax-problems-count');
  const dialog = requiredElement<HTMLDialogElement>('#syntax-problems-dialog');
  const list = requiredElement<HTMLElement>('#syntax-problems-list');
  const empty = requiredElement<HTMLElement>('#syntax-problems-empty');
  let timer: ReturnType<typeof setTimeout> | null = null;
  let revision = 0; let issues: LocalisationDiagnostic[] = []; let failed = false;
  let markedModel: Monaco.editor.ITextModel | null = null; let markerSignature = '';
  let indexError = '';

  function jumpTo(lineNumber: number, column: number): void {
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
        const related = issue.related;
        const first = document.createElement('button');
        first.type = 'button'; first.className = 'syntax-related';
        first.textContent = `Первое объявление: строка ${related.lineNumber}`;
        first.addEventListener('click', () => jumpTo(related.lineNumber, related.startColumn));
        row.append(first);
      }
      list.append(row);
    }
  }

  function publish(model: Monaco.editor.ITextModel, diagnostics: LocalisationDiagnostic[]): void {
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

  worker.onmessage = ({ data }: MessageEvent<SyntaxWorkerResult>) => {
    if (data.type === 'key-index-ready') { indexError = ''; schedule(); return; }
    if (data.type === 'key-index-error') {
      if (indexError !== data.error) showToast(`Индекс ссылок локализации недоступен: ${data.error}`, true);
      indexError = data.error ?? '';
      return;
    }
    if (data.id !== revision) return;
    const model = editor.getModel();
    if (!model || model.getVersionId() !== data.version) return;
    if (data.error) {
      if (!failed) showToast(`Проверка синтаксиса недоступна: ${data.error}`, true);
      failed = true;
      return;
    }
    failed = false;
    if (Array.isArray(data.diagnostics)) publish(model, data.diagnostics);
  };
  worker.onerror = () => {
    if (!failed) showToast('Фоновая проверка синтаксиса завершилась с ошибкой.', true);
    failed = true;
  };

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    revision += 1;
    const id = revision;
    timer = setTimeout(() => {
      const model = editor.getModel();
      if (!model || id !== revision) return;
      const filePath = getFilePath?.();
      if (getFilePath && !filePath) return;
      worker.postMessage({ id, version: model.getVersionId(), text: model.getValue(), filePath });
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
  requiredElement<HTMLButtonElement>('#syntax-problems-close').addEventListener('click', () => dialog.close());
  schedule();
  if (token) worker.postMessage({ type: 'init-key-index', token });

  return { refresh: schedule, dispose() {
    if (timer !== null) clearTimeout(timer);
    worker.terminate(); content.dispose(); modelChange.dispose();
    if (markedModel) monaco.editor.setModelMarkers(markedModel, MARKER_OWNER, []);
  } };
}
