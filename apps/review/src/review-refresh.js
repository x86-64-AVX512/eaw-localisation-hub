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
