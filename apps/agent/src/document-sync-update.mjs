import * as Y from 'yjs';

// The vector must describe the remote snapshot, not the merged local document:
// recovered offline inserts would otherwise look acknowledged by the server.
export function documentUpdateForServer(document, serverStateVector, hasPendingEdits) {
  const update = Y.encodeStateAsUpdate(document, serverStateVector ?? undefined);
  const decoded = Y.decodeUpdate(update);
  if (decoded.structs.length) return update;
  // State vectors do not acknowledge deletions. Keep a delete-only recovery
  // update even when both sides have identical struct clocks.
  if (decoded.ds.clients.size && (hasPendingEdits || !serverStateVector)) return update;
  // A recovered update may already be present remotely. Its tiny no-op frame
  // still participates in sync-flush, so the persisted recovery file can retire.
  if (hasPendingEdits) return update;
  return null;
}
