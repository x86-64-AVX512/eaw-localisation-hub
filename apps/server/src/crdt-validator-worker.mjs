import { parentPort } from 'node:worker_threads';
import * as Y from 'yjs';

parentPort.on('message', ({ id, update, baseUpdate }) => {
  const document = new Y.Doc();
  const startedAt = performance.now();
  try {
    if (baseUpdate?.byteLength) Y.applyUpdate(document, new Uint8Array(baseUpdate));
    const existingRoots = new Set(document.share.keys());
    Y.applyUpdate(document, new Uint8Array(update));
    // Rooms only use the shared text 'content'; other root types would be stored and
    // broadcast while staying invisible to every editor. Judge only roots this update
    // adds, so a room saved before this check still accepts ordinary edits.
    for (const name of document.share.keys()) {
      if (name !== 'content' && !existingRoots.has(name)) throw new Error('Unexpected root type');
    }
    const stateBytes = Y.encodeStateAsUpdate(document).byteLength;
    parentPort.postMessage({ id, ok: true, stateBytes, elapsedMilliseconds: performance.now() - startedAt });
  } catch {
    parentPort.postMessage({ id, ok: false, error: 'invalid-update' });
  } finally {
    document.destroy();
  }
});
