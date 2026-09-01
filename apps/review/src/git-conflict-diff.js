export function createGitConflictDiff({ monaco, state, send }) {
  const dialog = document.querySelector('#git-conflict-dialog');
  const heading = document.querySelector('#git-conflict-heading');
  const container = document.querySelector('#git-conflict-diff');
  let selected = null;
  let diffEditor = null;
  let originalModel = null;
  let modifiedModel = null;

  function disposeModels() {
    originalModel?.dispose();
    modifiedModel?.dispose();
    originalModel = null;
    modifiedModel = null;
  }

  function open(conflict) {
    selected = conflict;
    heading.textContent = `Конфликт Git: ${conflict.label}`;
    disposeModels();
    originalModel = monaco.editor.createModel(conflict.collaborativeLine || '', 'eaw-yaml');
    modifiedModel = monaco.editor.createModel(conflict.externalLine || '', 'eaw-yaml');
    diffEditor ??= monaco.editor.createDiffEditor(container, {
      theme: 'vs-dark', automaticLayout: true, readOnly: true,
      renderSideBySide: true, originalEditable: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 2 },
      minimap: { enabled: false }, scrollBeyondLastLine: false,
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    dialog.showModal();
  }

  function resolve(choice) {
    if (!selected) return;
    send({ type: 'externalConflictResolve', path: state.path, key: selected.key, choice });
    dialog.close();
  }
  document.querySelector('#git-conflict-keep').addEventListener('click', () => resolve('collaborative'));
  document.querySelector('#git-conflict-use').addEventListener('click', () => resolve('external'));
  document.querySelector('#git-conflict-close').addEventListener('click', () => dialog.close());
  return { open, dispose() { disposeModels(); diffEditor?.dispose(); } };
}
