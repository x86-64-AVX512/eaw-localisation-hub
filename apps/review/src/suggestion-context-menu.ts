import type * as Monaco from 'monaco-editor';

interface ContextMenuContribution extends Monaco.editor.IEditorContribution {
  showContextMenu(anchor: { x: number; y: number }): void;
}

export function isSuggestionMouseTarget(target: Monaco.editor.IMouseTarget): boolean {
  // These zones belong to the suggestion renderer. Monaco can hit-test the
  // containing layer rather than the actual child DOM node inside a zone.
  if (target.type === 5 || target.type === 8) return true;
  if (target.element?.closest('.active-suggestion-original-zone, .multiline-suggestion-zone')) return true;
  // Monaco deliberately leaves injected-text context menus to the host. The
  // WebView host has no native menu, so route only our own suggestion ghosts.
  const detail = ('detail' in target ? target.detail : null) as {
    injectedText?: { options?: { inlineClassName?: string } };
  } | null;
  return /(?:^|\s)suggestion-(?:strike|after)-/u.test(detail?.injectedText?.options?.inlineClassName ?? '');
}

export function createSuggestionContextMenu(editor: Monaco.editor.IStandaloneCodeEditor) {
  const dom = editor.getDomNode();
  const onContextMenu = (event: MouseEvent) => {
    const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
    if (!target || !isSuggestionMouseTarget(target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // Preserve selection and the active draft; moving the caret to an
    // artificial view-zone position could finish it before the menu opens.
    editor.focus();
    editor.getContribution<ContextMenuContribution>('editor.contrib.contextmenu')?.showContextMenu({ x: event.pageX, y: event.pageY });
  };
  // Capture before Monaco discards zone/injected-text targets, not after it.
  dom?.addEventListener('contextmenu', onContextMenu, true);
  return { dispose: () => dom?.removeEventListener('contextmenu', onContextMenu, true) };
}
