function changedContextRanges(changes, startKey, endKey, lineCount, contextLineCount) {
  if (!changes?.length || lineCount < 1) return [];
  const visible = changes.map((change) => {
    const changedStart = Math.max(1, Number(change[startKey]) || 1);
    const changedEnd = Math.max(changedStart, Number(change[endKey]) || changedStart);
    return {
      start: Math.max(1, changedStart - contextLineCount),
      end: Math.min(lineCount, changedEnd + contextLineCount),
    };
  }).sort((left, right) => left.start - right.start);
  const merged = [];
  for (const range of visible) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function hiddenRanges(monaco, visible, lineCount) {
  const hidden = [];
  let cursor = 1;
  for (const range of visible) {
    if (cursor < range.start) hidden.push(new monaco.Range(cursor, 1, range.start - 1, 1));
    cursor = range.end + 1;
  }
  if (cursor <= lineCount) hidden.push(new monaco.Range(cursor, 1, lineCount, 1));
  return hidden;
}

export function createStandardDiffView({
  monaco, container, language = 'eaw-yaml', contextLineCount = 2, editorOptions = {},
}) {
  container.classList.add('standard-diff');
  const originalModel = monaco.editor.createModel('', language);
  const modifiedModel = monaco.editor.createModel('', language);
  const diff = monaco.editor.createDiffEditor(container, {
    theme: 'vs-dark', readOnly: true, automaticLayout: true, minimap: { enabled: false },
    renderSideBySide: true, originalEditable: false, hideUnchangedRegions: { enabled: false },
    wordWrap: 'on', diffWordWrap: 'on', wordWrapOverride1: 'on', wordWrapOverride2: 'on',
    wrappingStrategy: 'advanced', scrollBeyondLastLine: false, ...editorOptions,
  });
  diff.setModel({ original: originalModel, modified: modifiedModel });

  function enforceOptions() {
    const options = {
      wordWrap: 'on', diffWordWrap: 'on', wordWrapOverride1: 'on', wordWrapOverride2: 'on',
      wrappingStrategy: 'advanced', wrappingIndent: 'same',
    };
    diff.updateOptions(options);
    diff.getOriginalEditor().updateOptions(options);
    diff.getModifiedEditor().updateOptions(options);
  }

  function clearHiddenAreas() {
    diff.getOriginalEditor().setHiddenAreas([]);
    diff.getModifiedEditor().setHiddenAreas([]);
  }

  function showChangedRegionsOnly() {
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
    diff.getOriginalEditor().setHiddenAreas(hiddenRanges(monaco, originalVisible, originalModel.getLineCount()));
    diff.getModifiedEditor().setHiddenAreas(hiddenRanges(monaco, modifiedVisible, modifiedModel.getLineCount()));
  }

  const diffUpdated = diff.onDidUpdateDiff(showChangedRegionsOnly);
  function layout() {
    diff.layout();
    enforceOptions();
    requestAnimationFrame(() => { diff.layout(); enforceOptions(); showChangedRegionsOnly(); });
  }
  function setOriginal(value) { clearHiddenAreas(); originalModel.setValue(value); layout(); }
  function setModified(value) { clearHiddenAreas(); modifiedModel.setValue(value); layout(); }
  function setTexts(original, modified) {
    clearHiddenAreas();
    originalModel.setValue(original);
    modifiedModel.setValue(modified);
    layout();
  }
  enforceOptions();
  return {
    diff, originalModel, modifiedModel, layout, setOriginal, setModified, setTexts,
    clear() { setTexts('', ''); },
    dispose() {
      diffUpdated.dispose(); diff.dispose(); originalModel.dispose(); modifiedModel.dispose();
    },
  };
}
