import { utf16ToByte } from './review-utilities.ts';
import type * as Monaco from 'monaco-editor';

const HEARTBEAT_MILLISECONDS = 15_000;

export interface PresenceControllerOptions {
  state: { ready: boolean; path: string };
  editor: Monaco.editor.IStandaloneCodeEditor;
  send: (message: { type: 'cursor'; path: string; positionByte: number; anchorByte: number }) => void;
}

export function createPresenceController({ state, editor, send }: PresenceControllerOptions) {
  function publish() {
    if (!state.ready) return;
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
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
