export async function closeDocument(binding) {
  binding.closing = true;
  if (binding.reconnectTimer) clearTimeout(binding.reconnectTimer);
  binding.socket?.close();
  binding.localPresences.clear();
  for (const client of binding.clients) {
    for (const state of client.documents.values()) {
      if (state.binding !== binding) continue;
      if (state.diskDebounce) clearTimeout(state.diskDebounce);
      if (state.diskPollTimer) clearInterval(state.diskPollTimer);
      state.diskWatcher?.close();
    }
  }
  const pendingBaseWrites = [...binding.baseWrites];
  for (const client of binding.clients) {
    for (const state of client.documents.values()) {
      if (state.binding === binding) pendingBaseWrites.push(state.basePersistPromise);
    }
  }
  await Promise.allSettled(pendingBaseWrites);
  for (const undo of binding.undoManagers.values()) undo.destroy();
  binding.document.destroy();
}
