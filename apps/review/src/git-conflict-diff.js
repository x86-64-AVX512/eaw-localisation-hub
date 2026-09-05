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
      wordWrap: 'on', diffWordWrap: 'on', wrappingStrategy: 'advanced',
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    dialog.showModal();
    requestAnimationFrame(() => {
      diffEditor.layout();
      diffEditor.getOriginalEditor().setScrollTop(0);
      diffEditor.getModifiedEditor().setScrollTop(0);
    });
  }

  function resolve(choice) {
    if (!selected) return;
    send({ type: 'externalConflictResolve', path: state.path, key: selected.key, choice });
    dialog.close();
  }
  document.querySelector('#git-conflict-keep').addEventListener('click', () => resolve('collaborative'));
  document.querySelector('#git-conflict-use').addEventListener('click', () => resolve('external'));
  document.querySelector('#git-conflict-close').addEventListener('click', () => dialog.close());
  document.querySelector('#git-conflict-fullscreen').addEventListener('click', (event) => {
    dialog.classList.toggle('fullscreen');
    event.currentTarget.textContent = dialog.classList.contains('fullscreen') ? 'Обычный размер' : 'На весь экран';
    requestAnimationFrame(() => diffEditor.layout());
  });
  return { open, dispose() { disposeModels(); diffEditor?.dispose(); } };
}
