import type * as Monaco from 'monaco-editor';
import { uiText } from '../../../packages/shared/src/ui-language.mts';

export interface ValueStatistics { key: string; characters: number; withoutWhitespace: number }
interface LineStatistics extends ValueStatistics { lineNumber: number }

/** Count source code points only: no reference expansion, markup stripping or game-width estimates. */
export function localisationValueStatistics(line: string): ValueStatistics | null {
  const prefix = /^\uFEFF?[ \t]*([^\s:#"]+):\d*[ \t]*"/u.exec(line);
  if (!prefix) return null;
  for (let end = prefix[0].length; end < line.length; end++) {
    if (line[end] === '\\') { end++; continue; }
    // Keep tolerant legacy inner quotes; do not include quotes in an inline comment.
    if (line[end] !== '"' || !/^\s*(?:#.*)?$/u.test(line.slice(end + 1))) continue;
    let characters = 0, withoutWhitespace = 0;
    for (const character of line.slice(prefix[0].length, end)) {
      characters++; if (!/\s/u.test(character)) withoutWhitespace++;
    }
    return { key: prefix[1], characters, withoutWhitespace };
  }
  return null;
}

export function createTextStatisticsAction({ editor, showToast, showResult }: {
  editor: Monaco.editor.IStandaloneCodeEditor;
  showToast: (text: string, error?: boolean) => void;
  showResult?: (statistics: LineStatistics) => void;
}) {
  let contextLine: number | null = null;
  let dialog: HTMLDialogElement | null = null;
  let disposed = false;
  function display(statistics: LineStatistics) {
    dialog?.close(); dialog?.remove();
    const current = document.createElement('dialog'); current.className = 'text-statistics-dialog';
    dialog = current;
    const shell = document.createElement('div'); shell.className = 'simple-dialog-shell';
    const heading = document.createElement('h2'); heading.textContent = uiText('Количество символов');
    current.setAttribute('aria-label', heading.textContent);
    const source = document.createElement('p'); source.textContent = uiText('Строка {0} · {1}', statistics.lineNumber, statistics.key);
    const count = document.createElement('p'); count.className = 'text-statistics-count';
    count.textContent = uiText('Между кавычками: {0} символов', statistics.characters);
    const compact = document.createElement('p'); compact.textContent = uiText('Без пробельных символов: {0}', statistics.withoutWhitespace);
    const hint = document.createElement('p'); hint.className = 'dialog-hint';
    hint.textContent = uiText('Считается исходное значение всей строки, без ключа и внешних кавычек. Теги и escape-последовательности включены; динамические ссылки не раскрываются. Это не проверка того, влезет ли текст в окно HoI4.');
    const close = document.createElement('button'); close.textContent = uiText('Закрыть');
    close.addEventListener('click', () => current.close());
    current.addEventListener('close', () => {
      current.remove();
      if (dialog === current) { dialog = null; if (!disposed) editor.focus(); }
    });
    shell.append(heading, source, count, compact, hint, close); current.append(shell);
    document.body.append(current); current.showModal(); close.focus();
  }
  function run() {
    if (disposed) return;
    const model = editor.getModel();
    const lineNumber = contextLine ?? editor.getPosition()?.lineNumber;
    contextLine = null;
    if (!model || !lineNumber || lineNumber > model.getLineCount()) return;
    const statistics = localisationValueStatistics(model.getLineContent(lineNumber));
    if (!statistics) {
      showToast(uiText('В этой строке нет значения локализации с закрытыми кавычками.'), true); return;
    }
    (showResult ?? display)({ ...statistics, lineNumber });
  }
  const context = editor.onContextMenu((event) => { contextLine = event.target.position?.lineNumber ?? null; });
  const cursor = editor.onDidChangeCursorPosition(() => { contextLine = null; });
  const model = editor.onDidChangeModel(() => { contextLine = null; });
  const action = editor.addAction({ id: 'eaw.review.countCharacters', label: uiText('Посчитать символы в строке'),
    contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 4, run });
  return { run, dispose() {
    disposed = true; context.dispose(); cursor.dispose(); model.dispose(); action.dispose(); dialog?.close(); dialog?.remove();
  } };
}
