import { parentPort } from 'node:worker_threads';
import * as Y from 'yjs';

parentPort.on('message', ({ id, update, baseUpdate }) => {
  const document = new Y.Doc();
  const startedAt = performance.now();
  try {
    if (baseUpdate?.byteLength) Y.applyUpdate(document, new Uint8Array(baseUpdate));
    Y.applyUpdate(document, new Uint8Array(update));
    const stateBytes = Y.encodeStateAsUpdate(document).byteLength;
    parentPort.postMessage({ id, ok: true, stateBytes, elapsedMilliseconds: performance.now() - startedAt });
  } catch {
    parentPort.postMessage({ id, ok: false, error: 'invalid-update' });
  } finally {
    document.destroy();
  }
});
