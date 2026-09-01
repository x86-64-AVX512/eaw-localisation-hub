export function reviewItemsAtByte(state, positionByte) {
  return [
    ...[...state.comments.values()].map((item) => ({ ...item, kind: 'comment' })),
    ...[...state.suggestions.values()].map((item) => ({ ...item, kind: 'suggestion' })),
  ].filter((item) => item.status === 'open'
      && item.startByte <= positionByte && positionByte <= item.endByte)
    .sort((left, right) => {
      const length = (left.endByte - left.startByte) - (right.endByte - right.startByte);
      return length || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
    });
}

export function createReviewNavigation({ state, editor, positionByteAt, focusCard, onSuggestion }) {
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
