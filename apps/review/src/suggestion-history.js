export function createSuggestionHistory(send) {
  let actions = [];
  let index = 0;
  return {
    record(action) {
      actions = actions.slice(0, index);
      actions.push({ ...action });
      index = actions.length;
    },
    undo(path) {
      if (index === 0) return false;
      index -= 1;
      send({ type: 'suggestionDelete', path, id: actions[index].suggestionId });
      return true;
    },
    redo() {
      if (index >= actions.length) return false;
      send({ ...actions[index] });
      index += 1;
      return true;
    },
    clear() {
      actions = [];
      index = 0;
    },
  };
}
