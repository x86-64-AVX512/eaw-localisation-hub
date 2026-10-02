import { WebSocket } from 'ws';
import { sendWithBackpressure } from './protocol-limits.mts';

// The blob check still happens before addClient. Only the informational list
// may fetch older Git history in the background, after document sync starts.
export async function sendStartupChangedFiles(source, documentId, socket, room, snapshot) {
  if (!source.enabled || !snapshot || snapshot.stale || socket.localHead === snapshot.commit) return;
  const localHead = socket.localHead;
  try {
    const files = await source.changedFilesSince(documentId, localHead, { remoteHead: snapshot.commit });
    await room.enqueueMessage(() => {
      if (socket.readyState !== WebSocket.OPEN || !room.clients.has(socket)
        || socket.localHead !== localHead || room.gitConflict || room.gitBase?.stale
        || room.gitBase?.commit !== snapshot.commit || room.gitBase?.blob !== snapshot.blob) return;
      if (!files.some((file) => !(socket.changedFiles ?? []).includes(file))) return;
      socket.changedFiles = [...new Set([...(socket.changedFiles ?? []), ...files])].slice(0, 500);
      sendWithBackpressure(socket, JSON.stringify(room.gitStatusFor(socket)));
    });
  } catch {
    // An unavailable history must not fail an already validated connection.
  }
}
