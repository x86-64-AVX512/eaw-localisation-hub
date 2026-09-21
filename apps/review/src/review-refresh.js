export function createReviewRefresh(refresh) {
  let batchDepth = 0;
  let frame = 0;

  function schedule() {
    if (batchDepth > 0 || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }

  function handleBatch(type) {
    if (type === 'reviewBatchStart') {
      batchDepth += 1;
      return true;
    }
    if (type === 'reviewBatchEnd') {
      batchDepth = Math.max(0, batchDepth - 1);
      if (batchDepth === 0) schedule();
      return true;
    }
    return false;
  }

  return {
    schedule,
    handleBatch,
    dispose() { if (frame) cancelAnimationFrame(frame); },
  };
}

export function createCollaborationRefresh(refreshDecorations, panel) {
  const sections = new Set();
  const refresh = createReviewRefresh(() => {
    const requested = new Set(sections);
    sections.clear();
    if (requested.has('presences') || requested.has('reservations')) refreshDecorations();
    panel.refresh(requested);
  });
  return {
    schedule(type) {
      if (type.startsWith('presence')) sections.add('presences');
      else if (type.startsWith('reservationTarget')) {
        sections.add('targets'); sections.add('reservations');
      } else if (type.startsWith('reservation')) sections.add('reservations');
      else if (type.startsWith('externalConflict')) sections.add('conflicts');
      if (sections.size) refresh.schedule();
    },
    refreshAll() { sections.clear(); refreshDecorations(); panel.refresh(); },
    dispose: refresh.dispose,
  };
}
