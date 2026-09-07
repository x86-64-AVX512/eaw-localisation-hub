// Push notifications are the fast path; revision polling recovers missed signals
// without downloading all tickets repeatedly. A single refresh runs at a time.
export function createTicketCatalogWatch({ refresh, revision, currentRevision, interval = 15000 }) {
  let running = null;
  let pending = false;
  let disposed = false;
  function changed(value = '') {
    if (disposed || (value && value === currentRevision())) return Promise.resolve();
    pending = true;
    if (running) return running;
    running = (async () => {
      while (pending && !disposed) { pending = false; await refresh(); }
    })().finally(() => { running = null; });
    return running;
  }
  async function check() {
    if (disposed || document.hidden) return;
    try { await changed((await revision()).revision); } catch { /* retry on next tick or focus */ }
  }
  const timer = setInterval(check, interval);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  return {
    changed,
    dispose() {
      disposed = true; clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    },
  };
}
