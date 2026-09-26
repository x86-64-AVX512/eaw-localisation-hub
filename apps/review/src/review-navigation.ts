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

export function createReviewNavigation({ state, editor, positionByteAt, focusCard, onSuggestion }: {
  state: ReviewNavigationState;
  editor: Monaco.editor.IStandaloneCodeEditor;
  positionByteAt: (position: Monaco.IPosition) => number;
  focusCard: (kind: PositionedReviewItem['kind'], id: string) => boolean;
  onSuggestion: (item: PositionedReviewItem) => void;
}) {
  let lastPosition = -1;
  let lastKeys = '';
  let index = 0;
  return editor.onMouseUp((event) => {
    if (!event.target.position || state.editingSuggestionId) return;
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
}
