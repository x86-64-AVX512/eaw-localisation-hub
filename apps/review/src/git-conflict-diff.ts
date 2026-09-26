import type * as Monaco from 'monaco-editor';
import { requiredElement } from './dom-elements.ts';
import type { ReviewExternalConflict } from './review-state.ts';

export function createGitConflictDiff({ monaco, state, send }: {
  monaco: typeof Monaco;
  state: { path: string };
  send: (message: { type: 'externalConflictResolve'; path: string; key: string; choice: 'collaborative' | 'external' }) => void;
}) {
  const dialog = requiredElement<HTMLDialogElement>('#git-conflict-dialog');
  const heading = requiredElement<HTMLElement>('#git-conflict-heading');
  const container = requiredElement<HTMLElement>('#git-conflict-diff');
  let selected: ReviewExternalConflict | null = null;
  let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
  let originalModel: Monaco.editor.ITextModel | null = null;
  let modifiedModel: Monaco.editor.ITextModel | null = null;

  function disposeModels(): void {
    originalModel?.dispose();
    modifiedModel?.dispose();
    originalModel = null;
    modifiedModel = null;
  }

  function open(conflict: ReviewExternalConflict): void {
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
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    dialog.showModal();
    requestAnimationFrame(() => {
      diffEditor?.layout();
      diffEditor?.getOriginalEditor().setScrollTop(0);
      diffEditor?.getModifiedEditor().setScrollTop(0);
    });
  }

  function resolve(choice: 'collaborative' | 'external'): void {
    if (!selected) return;
    send({ type: 'externalConflictResolve', path: state.path, key: selected.key, choice });
    dialog.close();
  }
  requiredElement<HTMLButtonElement>('#git-conflict-keep').addEventListener('click', () => resolve('collaborative'));
  requiredElement<HTMLButtonElement>('#git-conflict-use').addEventListener('click', () => resolve('external'));
  requiredElement<HTMLButtonElement>('#git-conflict-close').addEventListener('click', () => dialog.close());
  const fullscreen = requiredElement<HTMLButtonElement>('#git-conflict-fullscreen');
  fullscreen.addEventListener('click', () => {
    dialog.classList.toggle('fullscreen');
    fullscreen.textContent = dialog.classList.contains('fullscreen') ? 'Обычный размер' : 'На весь экран';
    requestAnimationFrame(() => diffEditor?.layout());
  });
  return { open, dispose() { disposeModels(); diffEditor?.dispose(); } };
}
