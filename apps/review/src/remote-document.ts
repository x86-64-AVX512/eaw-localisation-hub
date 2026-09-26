import * as monaco from 'monaco-editor';
import { byteToUtf16, decodeBase64 } from './review-utilities.ts';
import { createReviewDocument } from './review-document.ts';
import { singleReplacement } from './editing-mode.ts';
import type { ReviewDocumentMessage } from './review-document.ts';

export interface RemoteDocumentState {
  documentVariants: { shared: string } | null;
  documentView: string;
  applyingRemote: boolean;
  reviewDocument?: ReturnType<typeof createReviewDocument> | null;
}

export interface RemoteDocumentOptions {
  state: RemoteDocumentState;
  editor: monaco.editor.IStandaloneCodeEditor;
  editingMode: { beforeRemoteChange(): void; afterRemoteChange(): void };
  send: (message: ReviewDocumentMessage) => void;
  onChanged: () => void;
}

export interface RemoteReplacement {
  positionByte: number;
  deleteBytes: number;
  insertBase64: string;
}

export function createCrdtRemoteDocument({ state, editor, editingMode, send, onChanged }: RemoteDocumentOptions) {
  return createReviewDocument({
    send,
    beforeChange: () => editingMode.beforeRemoteChange(),
    onText: (text) => {
      if (state.documentVariants) state.documentVariants.shared = text;
      if (state.documentView !== 'shared') return;
      const model = editor.getModel();
      if (!model) return;
      state.applyingRemote = true;
      try { model.setEOL(text.includes('\r\n') ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF); }
      finally { state.applyingRemote = false; }
      const change = singleReplacement(model.getValue(), text);
      if (change) {
        state.applyingRemote = true;
        try {
          model.pushEditOperations([], [{
            range: monaco.Range.fromPositions(model.getPositionAt(change.start), model.getPositionAt(change.previousEnd)),
            text: change.replacement,
          }], () => null);
        } finally { state.applyingRemote = false; }
      }
      editingMode.afterRemoteChange();
      onChanged();
    },
  });
}

export function createRemoteDocument({ state, editor, editingMode, send, onChanged }: RemoteDocumentOptions) {
  state.reviewDocument = createCrdtRemoteDocument({ state, editor, editingMode, send, onChanged });
  return function applyRemoteReplace(message: RemoteReplacement): void {
    if (state.documentView !== 'shared' && state.documentVariants) {
      const current = state.documentVariants.shared;
      const start = byteToUtf16(current, message.positionByte);
      const end = byteToUtf16(current, message.positionByte + message.deleteBytes);
      state.documentVariants.shared = current.slice(0, start)
        + decodeBase64(message.insertBase64) + current.slice(end);
      return;
    }
    const model = editor.getModel();
    if (!model) return;
    editingMode.beforeRemoteChange();
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
