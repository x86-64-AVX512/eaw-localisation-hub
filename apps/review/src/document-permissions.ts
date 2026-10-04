import { canEditDocument } from '../../../packages/shared/src/document-permissions.mts';

export function applyDocumentPermissions(state: { roles?: string[]; relativePath: string; ticket?: { status?: string } | null },
  editor: { updateOptions(options: { readOnly: boolean }): void }): void {
  const blocked = !canEditDocument(state, state.relativePath) || ['applied', 'closed'].includes(state.ticket?.status ?? '');
  if (blocked) editor.updateOptions({ readOnly: true });
  for (const id of ['mode-edit', 'mode-suggest', 'undo', 'redo', 'reservation-create', 'reservation-delete-at', 'reservation-delete']) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) button.disabled = blocked;
  }
}
