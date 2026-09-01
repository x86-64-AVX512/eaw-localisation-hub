export function resetExternalConflicts(state, source = '') {
  if (!source) {
    state.externalConflicts.clear();
  } else {
    for (const [id, conflict] of state.externalConflicts) {
      if ((conflict.source || 'disk') === source) state.externalConflicts.delete(id);
    }
  }
  if (!state.externalConflicts.has(state.selectedConflict)) state.selectedConflict = '';
}

export function storeExternalConflict(state, message) {
  const source = message.source || 'disk';
  state.externalConflicts.set(`${source}:${message.key}`, { ...message, source });
}
