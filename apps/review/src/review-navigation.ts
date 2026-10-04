import type * as Monaco from 'monaco-editor';

export interface ReviewNavigationItem {
  id: string;
  status: string;
  startByte: number;
  endByte: number;
  authorId?: string;
  author?: string;
}

export interface ReviewNavigationState {
  comments: Map<string, ReviewNavigationItem>;
  suggestions: Map<string, ReviewNavigationItem>;
  editingSuggestionId: string;
}

export type PositionedReviewItem = ReviewNavigationItem & { kind: 'comment' | 'suggestion' };

export function reviewItemsAtByte(
  state: Pick<ReviewNavigationState, 'comments' | 'suggestions'>,
  positionByte: number,
): PositionedReviewItem[] {
  return [
    ...[...state.comments.values()].map((item) => ({ ...item, kind: 'comment' as const })),
    ...[...state.suggestions.values()].map((item) => ({ ...item, kind: 'suggestion' as const })),
  ].filter((item) => item.status === 'open'
      && item.startByte <= positionByte && positionByte <= item.endByte)
    .sort((left, right) => {
      const length = (left.endByte - left.startByte) - (right.endByte - right.startByte);
      return length || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
    });
}

export function createReviewNavigation({ state, editor, positionByteAt, focusCard, onSuggestion, finishSuggestionAt }: {
  state: ReviewNavigationState;
  editor: Monaco.editor.IStandaloneCodeEditor;
  positionByteAt: (position: Monaco.IPosition) => number;
  focusCard: (kind: PositionedReviewItem['kind'], id: string) => boolean;
  onSuggestion: (item: PositionedReviewItem) => void;
  finishSuggestionAt?: (position: Monaco.IPosition) => boolean;
}) {
  let lastPosition = -1;
  let lastKeys = '';
  let index = 0;
  let editingAtMouseDown = false;
  const domNode = editor.getDomNode();
  const mouseDown = (event: MouseEvent) => {
    // Capture before Monaco moves its cursor. Its onMouseDown notification
    // runs after cursor listeners may have restored the canonical model.
    editingAtMouseDown = Boolean(state.editingSuggestionId);
    if (!editingAtMouseDown || !finishSuggestionAt || event.button !== 0
      || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
    // Original view-zone text is a preview, not an outside editor click.
    if (!target?.position || target.type === 5 || target.type === 8) return;
    if (!finishSuggestionAt(target.position)) return;
    // Finish before Monaco begins a gesture on the projected model. Letting
    // that gesture continue on the restored base selects unrelated lines.
    event.preventDefault(); event.stopImmediatePropagation(); editor.focus();
  };
  domNode?.addEventListener('mousedown', mouseDown, true);
  const mouseUp = editor.onMouseUp((event) => {
    const finishingDraft = editingAtMouseDown;
    editingAtMouseDown = false;
    // Right-click opens Monaco's context menu. Moving focus to a card on
    // mouse-up would immediately dismiss that menu (and could open a draft).
    if (finishingDraft || !event.event.leftButton || !event.target.position || state.editingSuggestionId) return;
    const positionByte = positionByteAt(event.target.position);
    const items = reviewItemsAtByte(state, positionByte);
    if (items.length === 0) return;
    const keys = items.map((item) => `${item.kind}:${item.id}`).join('|');
    if (lastPosition === positionByte && lastKeys === keys) index = (index + 1) % items.length;
    else index = 0;
    lastPosition = positionByte;
    lastKeys = keys;
    const item = items[index];
    focusCard(item.kind, item.id);
    if (item.kind === 'suggestion') onSuggestion(item);
  });
  return { dispose() { domNode?.removeEventListener('mousedown', mouseDown, true); mouseUp.dispose(); } };
}
