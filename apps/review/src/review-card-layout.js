export function createReviewCardLayout({ state, editor, rangeFromBytes, cards, connectors, lane }) {
  function layout() {
    if (!state.path) return;
    const editorRect = document.querySelector('#editor').getBoundingClientRect();
    const workspaceRect = document.querySelector('#workspace').getBoundingClientRect();
    const laneRect = lane.getBoundingClientRect();
    connectors.replaceChildren();
    let nextTop = 46;
    for (const card of cards.children) {
      let position;
      try { position = rangeFromBytes(Number(card.dataset.startByte), Number(card.dataset.startByte)).getStartPosition(); }
      catch { continue; }
      const desiredTop = editor.getTopForLineNumber(position.lineNumber) + 46;
      const top = Math.max(desiredTop, nextTop);
      card.style.top = `${top}px`;
      nextTop = top + card.offsetHeight + 8;
      const visible = editor.getScrolledVisiblePosition(position);
      if (!visible || visible.top < -30 || visible.top > editorRect.height) continue;
      const cardRect = card.getBoundingClientRect();
      if (cardRect.bottom < laneRect.top + 38 || cardRect.top > laneRect.bottom) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const startX = editorRect.right - workspaceRect.left - 8;
      const startY = visible.top + visible.height / 2;
      const endX = laneRect.left - workspaceRect.left + 10;
      const endY = cardRect.top - workspaceRect.top + Math.min(30, card.offsetHeight / 2);
      line.setAttribute('d', `M ${startX} ${startY} C ${startX + 28} ${startY}, ${endX - 28} ${endY}, ${endX} ${endY}`);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', getComputedStyle(card).getPropertyValue('--author-color'));
      line.setAttribute('stroke-width', '1.5'); line.setAttribute('opacity', '.8'); connectors.append(line);
    }
    cards.style.height = `${Math.max(editor.getContentHeight() + 46, nextTop + 12)}px`;
  }
  function syncScroll() {
    const next = Math.max(0, Math.min(lane.scrollHeight - lane.clientHeight, editor.getScrollTop()));
    if (Math.abs(lane.scrollTop - next) > 1) lane.scrollTop = next;
    layout();
  }
  return { layout, syncScroll };
}
