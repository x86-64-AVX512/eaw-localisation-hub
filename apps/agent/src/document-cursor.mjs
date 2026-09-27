import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { utf8ByteOffsetToUtf16Index } from '../../../packages/shared/src/text.mts';

function encodeRelativePosition(position) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

export function cursor(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  const pendingCursor = {
    positionByte: Number(message.positionByte),
    anchorByte: Number(message.anchorByte ?? message.positionByte),
  };
  let caret;
  let anchor;
  try {
    caret = utf8ByteOffsetToUtf16Index(state.mirror, pendingCursor.positionByte);
    anchor = pendingCursor.anchorByte === pendingCursor.positionByte ? caret
      : utf8ByteOffsetToUtf16Index(state.mirror, pendingCursor.anchorByte);
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
  state.pendingCursor = pendingCursor;
  if (!state.initialised) return true;
  binding.localPresences.update(client, {
    type: 'presence',
    clientId: binding.hub.presenceClientId,
    user: binding.hub.options.user,
    color: binding.hub.options.color,
    caretRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(binding.text, caret)),
    anchorRelative: encodeRelativePosition(Y.createRelativePositionFromTypeIndex(binding.text, anchor)),
  });
  return true;
}
