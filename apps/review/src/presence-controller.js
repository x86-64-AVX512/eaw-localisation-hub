import { utf16ToByte } from './review-utilities.js';

const HEARTBEAT_MILLISECONDS = 15_000;

export function createPresenceController({ state, editor, send }) {
  function publish() {
    if (!state.ready) return;
    const model = editor.getModel();
    const selection = editor.getSelection();
    send({
      type: 'cursor',
      path: state.path,
      positionByte: utf16ToByte(model.getValue(), model.getOffsetAt(selection.getPosition())),
      anchorByte: utf16ToByte(model.getValue(), model.getOffsetAt(selection.getSelectionStart())),
    });
  }

  const selectionSubscription = editor.onDidChangeCursorSelection(publish);
  const heartbeat = setInterval(publish, HEARTBEAT_MILLISECONDS);
  return {
    publish,
    dispose() {
      clearInterval(heartbeat);
      selectionSubscription.dispose();
    },
  };
}
