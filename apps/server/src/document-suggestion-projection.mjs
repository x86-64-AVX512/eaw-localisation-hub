import * as Y from 'yjs';

// Project an edit against a detached document so budget checks precede any live mutation.
export function projectedSuggestionStateBytes(document, start, end, replacementText) {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document));
    const text = candidate.getText('content');
    text.delete(start, end - start);
    if (replacementText) text.insert(start, replacementText);
    return Y.encodeStateAsUpdate(candidate).byteLength;
  } finally {
    candidate.destroy();
  }
}
