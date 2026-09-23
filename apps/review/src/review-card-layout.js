export function createReviewCardLayout({ state, editor, rangeFromBytes, cards, connectors, lane }) {
  let pendingFrame = 0;
  function performLayout() {
    pendingFrame = 0;
    if (!state.path) return;
    const editorRect = document.querySelector('#editor').getBoundingClientRect();
    const workspaceRect = document.querySelector('#workspace').getBoundingClientRect();
    const laneRect = lane.getBoundingClientRect();
    const cardsRect = cards.getBoundingClientRect();
    // Read all heights before changing any top position. Mixing reads and
    // writes per card forces the browser to lay out the whole lane repeatedly.
    const entries = [];
    for (const card of cards.children) {
      let position;
      try { position = rangeFromBytes(Number(card.dataset.startByte), Number(card.dataset.startByte)).getStartPosition(); }
      catch { continue; }
      entries.push({ card, position, height: card.offsetHeight,
        desiredTop: editor.getTopForLineNumber(position.lineNumber) + 46,
        visible: editor.getScrolledVisiblePosition(position),
        color: card.style.getPropertyValue('--author-color') });
    }
    const paths = document.createDocumentFragment();
    let nextTop = 46;
    for (const { card, height, desiredTop, visible, color } of entries) {
      const top = Math.max(desiredTop, nextTop);
      card.style.top = `${top}px`;
      nextTop = top + height + 8;
      if (!visible || visible.top < -30 || visible.top > editorRect.height) continue;
      const cardTop = cardsRect.top + top;
      if (cardTop + height < laneRect.top + 38 || cardTop > laneRect.bottom) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const startX = editorRect.right - workspaceRect.left - 8;
      const startY = visible.top + visible.height / 2;
      const endX = laneRect.left - workspaceRect.left + 10;
      const endY = cardTop - workspaceRect.top + Math.min(30, height / 2);
      line.setAttribute('d', `M ${startX} ${startY} C ${startX + 28} ${startY}, ${endX - 28} ${endY}, ${endX} ${endY}`);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '1.5'); line.setAttribute('opacity', '.8'); paths.append(line);
    }
    connectors.replaceChildren(paths);
    const height = `${Math.max(editor.getContentHeight() + 46, nextTop + 12)}px`;
    if (cards.style.height !== height) cards.style.height = height;
  }
  function layout() {
    if (!pendingFrame) pendingFrame = requestAnimationFrame(performLayout);
  }
  function syncScroll() {
    const next = Math.max(0, Math.min(lane.scrollHeight - lane.clientHeight, editor.getScrollTop()));
    if (Math.abs(lane.scrollTop - next) > 1) lane.scrollTop = next;
    layout();
  }
  return { layout, syncScroll };
}
