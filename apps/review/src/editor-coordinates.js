import { baseToProjectedOffset, projectedToBaseOffset } from './editing-mode.js';
import { byteToUtf16, utf16ToByte } from './review-utilities.js';

export function createEditorCoordinates({ monaco, state, editor }) {
  function rangeFromBytes(startByte, endByte) {
    const model = editor.getModel();
    const projection = state.suggestionProjection;
    const text = projection?.baseText ?? model.getValue();
    const baseStart = byteToUtf16(text, Number(startByte));
    const baseEnd = byteToUtf16(text, Number(endByte));
    const startOffset = baseToProjectedOffset(projection, baseStart, 'before');
    const endOffset = baseToProjectedOffset(projection, baseEnd, startByte === endByte ? 'before' : 'after');
    const start = model.getPositionAt(startOffset);
    const end = model.getPositionAt(endOffset);
    return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
  }
  function selectionBytes() {
    const model = editor.getModel();
    const selection = editor.getSelection();
    const projection = state.suggestionProjection;
    const source = projection?.baseText ?? model.getValue();
    const start = projectedToBaseOffset(projection, model.getOffsetAt(selection.getStartPosition()));
    const end = projectedToBaseOffset(projection, model.getOffsetAt(selection.getEndPosition()));
    return { start: utf16ToByte(source, start), end: utf16ToByte(source, end) };
  }
  function jumpToBytes(startByte, endByte = startByte) {
    const range = rangeFromBytes(startByte, endByte);
    editor.revealRangeInCenter(range);
    editor.setSelection(range);
    editor.focus();
  }
  return { rangeFromBytes, selectionBytes, jumpToBytes };
}
