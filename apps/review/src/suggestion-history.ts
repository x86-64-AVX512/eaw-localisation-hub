export interface SuggestionHistoryAction {
  type: string;
  path: string;
  suggestionId: string;
  [key: string]: unknown;
}

export type SuggestionHistoryCommand = SuggestionHistoryAction
  | { type: 'suggestionDelete'; path: string; id: string };

export function createSuggestionHistory(send: (message: SuggestionHistoryCommand) => void) {
  let actions: SuggestionHistoryAction[] = [];
  let index = 0;
  return {
    record(action: SuggestionHistoryAction) {
      actions = actions.slice(0, index);
      actions.push({ ...action });
      index = actions.length;
    },
    undo(path: string) {
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
