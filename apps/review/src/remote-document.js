import * as monaco from 'monaco-editor';
import { byteToUtf16, decodeBase64 } from './review-utilities.js';

export function createRemoteDocument({ state, editor, editingMode, onChanged }) {
  return function applyRemoteReplace(message) {
    if (state.documentView !== 'shared' && state.documentVariants) {
      const current = state.documentVariants.shared;
      const start = byteToUtf16(current, message.positionByte);
      const end = byteToUtf16(current, message.positionByte + message.deleteBytes);
      state.documentVariants.shared = current.slice(0, start)
        + decodeBase64(message.insertBase64) + current.slice(end);
      return;
    }
    editingMode.beforeRemoteChange();
    const model = editor.getModel();
    const current = model.getValue();
    const start = byteToUtf16(current, message.positionByte);
    const end = byteToUtf16(current, message.positionByte + message.deleteBytes);
    state.applyingRemote = true;
    model.pushEditOperations([], [{
      range: monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)),
      text: decodeBase64(message.insertBase64),
    }], () => null);
    state.applyingRemote = false;
    editingMode.afterRemoteChange();
    if (state.documentVariants) state.documentVariants.shared = model.getValue();
    onChanged();
  };
}
