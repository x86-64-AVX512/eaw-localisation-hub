import type * as Monaco from 'monaco-editor';

interface LineRange { start: number; end: number }
type HiddenAreasEditor = Monaco.editor.IStandaloneCodeEditor & {
  setHiddenAreas(ranges: Monaco.Range[]): void;
};

function setHiddenAreas(editor: Monaco.editor.IStandaloneCodeEditor, ranges: Monaco.Range[]): void {
  // Monaco exposes this on the editor instance, though its public declaration omits it.
  (editor as HiddenAreasEditor).setHiddenAreas(ranges);
}

function changedContextRanges(
  changes: readonly Monaco.editor.ILineChange[] | null,
  startKey: 'originalStartLineNumber' | 'modifiedStartLineNumber',
  endKey: 'originalEndLineNumber' | 'modifiedEndLineNumber',
  lineCount: number,
  contextLineCount: number,
): LineRange[] {
  if (!changes?.length || lineCount < 1) return [];
  const visible = changes.map((change) => {
    const changedStart = Math.max(1, Number(change[startKey]) || 1);
    const changedEnd = Math.max(changedStart, Number(change[endKey]) || changedStart);
    return {
      start: Math.max(1, changedStart - contextLineCount),
      end: Math.min(lineCount, changedEnd + contextLineCount),
    };
  }).sort((left, right) => left.start - right.start);
  const merged: LineRange[] = [];
  for (const range of visible) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function hiddenRanges(monaco: typeof Monaco, visible: readonly LineRange[], lineCount: number): Monaco.Range[] {
  const hidden: Monaco.Range[] = [];
  let cursor = 1;
  for (const range of visible) {
    if (cursor < range.start) hidden.push(new monaco.Range(cursor, 1, range.start - 1, 1));
    cursor = range.end + 1;
  }
  if (cursor <= lineCount) hidden.push(new monaco.Range(cursor, 1, lineCount, 1));
  return hidden;
}

export interface StandardDiffViewOptions {
  monaco: typeof Monaco;
  container: HTMLElement;
  language?: string;
  contextLineCount?: number;
  editorOptions?: Partial<Monaco.editor.IStandaloneDiffEditorConstructionOptions>;
  preserveOnDeactivate?: boolean;
}

export function createStandardDiffView({
  monaco, container, language = 'eaw-yaml', contextLineCount = 2, editorOptions = {},
  preserveOnDeactivate = false,
}: StandardDiffViewOptions) {
  container.classList.add('standard-diff');
  const originalModel = monaco.editor.createModel('', language);
  const modifiedModel = monaco.editor.createModel('', language);
  const diff = monaco.editor.createDiffEditor(container, {
    theme: 'vs-dark', readOnly: true, automaticLayout: !preserveOnDeactivate,
    minimap: { enabled: false },
    renderSideBySide: true, originalEditable: false, hideUnchangedRegions: { enabled: false },
    wordWrap: 'on', diffWordWrap: 'on', wordWrapOverride1: 'on', wordWrapOverride2: 'on',
    wrappingStrategy: 'advanced', scrollBeyondLastLine: false, ...editorOptions,
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
  });
  diff.setModel({ original: originalModel, modified: modifiedModel });
  let active = true;
  let layoutFrame = 0;
  let hiddenSignature = '';

  function enforceOptions() {
    const options = {
      wordWrap: 'on', diffWordWrap: 'on', wordWrapOverride1: 'on', wordWrapOverride2: 'on',
      wrappingStrategy: 'advanced', wrappingIndent: 'same',
    } as const;
    diff.updateOptions(options);
    diff.getOriginalEditor().updateOptions(options);
    diff.getModifiedEditor().updateOptions(options);
  }

  function clearHiddenAreas() {
    if (!active || hiddenSignature === 'all') return;
    hiddenSignature = 'all';
    setHiddenAreas(diff.getOriginalEditor(), []);
    setHiddenAreas(diff.getModifiedEditor(), []);
  }

  function showChangedRegionsOnly() {
    if (!active) return;
    const changes = diff.getLineChanges();
    if (!changes) return;
    if (!changes.length) { clearHiddenAreas(); return; }
    const originalVisible = changedContextRanges(
      changes, 'originalStartLineNumber', 'originalEndLineNumber',
      originalModel.getLineCount(), contextLineCount,
    );
    const modifiedVisible = changedContextRanges(
      changes, 'modifiedStartLineNumber', 'modifiedEndLineNumber',
      modifiedModel.getLineCount(), contextLineCount,
    );
    const signature = JSON.stringify([originalVisible, modifiedVisible]);
    if (signature === hiddenSignature) return;
    hiddenSignature = signature;
    setHiddenAreas(diff.getOriginalEditor(), hiddenRanges(monaco, originalVisible, originalModel.getLineCount()));
    setHiddenAreas(diff.getModifiedEditor(), hiddenRanges(monaco, modifiedVisible, modifiedModel.getLineCount()));
  }

  const diffUpdated = diff.onDidUpdateDiff(showChangedRegionsOnly);
  function layout() {
    if (!active) return;
    window.cancelAnimationFrame(layoutFrame);
    diff.layout();
    enforceOptions();
    if (preserveOnDeactivate) diff.getOriginalEditor().layout();
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = 0;
      if (!active) return;
      diff.layout();
      enforceOptions();
      showChangedRegionsOnly();
    });
  }
  function setOriginal(value: string): void { hiddenSignature = ''; clearHiddenAreas(); originalModel.setValue(value); layout(); }
  function setModified(value: string): void { hiddenSignature = ''; clearHiddenAreas(); modifiedModel.setValue(value); layout(); }
  function setTexts(original: string, modified: string): void {
    hiddenSignature = ''; clearHiddenAreas();
    originalModel.setValue(original);
    modifiedModel.setValue(modified);
    layout();
  }
  enforceOptions();
  return {
    diff, originalModel, modifiedModel, layout, setOriginal, setModified, setTexts,
    setActive(value: boolean) {
      const next = value === true;
      if (active === next) return;
      active = next;
      window.cancelAnimationFrame(layoutFrame);
      layoutFrame = 0;
      if (!active) {
        if (!preserveOnDeactivate) diff.setModel(null);
        return;
      }
      if (!preserveOnDeactivate) {
        hiddenSignature = '';
        diff.setModel({ original: originalModel, modified: modifiedModel });
      }
      layout();
    },
    clear() { setTexts('', ''); },
    dispose() {
      active = false;
      window.cancelAnimationFrame(layoutFrame);
      diffUpdated.dispose(); diff.dispose(); originalModel.dispose(); modifiedModel.dispose();
    },
  };
}
