import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '../../../packages/shared/src/constants.mts';
import { validateServerMessage } from '../../../packages/shared/src/protocol-schema.mts';
import { currentGitCommitAsync, currentGitFileBlobAsync } from './git-ticket-context.mts';
import { CliError } from './cli-protocol.mjs';

// A short-lived subscription gets the server's shared text and does not attach a
// Review client, claim a seed, materialise a file, or reconcile a working copy.
export async function withCliDocument(
  hub,
  { relativePath, ticketId, workspace },
  signal,
  operation,
  { writing = false, historyId = '', recheck = () => {} } = {},
) {
  const documentId = `${ticketId ? `ticket-${ticketId}` : workspace}:${relativePath}`;
  let supported;
  try {
    supported = await hub.ensureCliServerSupport(signal);
  } catch {
    signal.throwIfAborted();
    throw new CliError('SERVER_UNAVAILABLE', 'The document server did not respond.', 503);
  }
  if (!supported) {
    throw new CliError('UNSUPPORTED_SERVER', 'Update the Hub server to use the CLI.', 409);
  }
  const url = new URL(hub.options.server);
  url.searchParams.set('document', documentId);
  url.searchParams.set('automation', writing ? 'write' : '1');
  if (writing && !ticketId) {
    const repo = hub.options.repo;
    const [head, blob] = await Promise.all([
      currentGitCommitAsync(repo, signal).catch(() => ''),
      currentGitFileBlobAsync(repo, relativePath, signal).catch(() => ''),
    ]);
    if (head) url.searchParams.set('head', head);
    if (blob) url.searchParams.set('blob', blob);
  }
  signal.throwIfAborted();
  recheck();
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${hub.options.token}` },
    maxPayload: MAX_MESSAGE_BYTES,
    handshakeTimeout: 8000,
  });
  const document = new Y.Doc();
  let sentRequest = '';
  let resolveWrite;
  return new Promise((resolve, reject) => {
    let finished = false;
    let synced = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.terminate();
      document.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const disconnected = () =>
      sentRequest
        ? new CliError('OUTCOME_UNKNOWN', 'The server did not confirm the write. Retry with the same ID.', 504)
        : new CliError('SERVER_UNAVAILABLE', 'The document server did not respond.', 503);
    const abort = () => finish(sentRequest ? disconnected() : signal.reason);
    const timer = setTimeout(() => finish(disconnected()), 30_000);
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(disconnected()));
    socket.on('close', (code) => {
      const error =
        code === 1008 && !sentRequest
          ? new CliError('FORBIDDEN', 'The server denied access to this document.', 403)
          : disconnected();
      finish(error);
    });
    socket.on('message', (data, binary) => {
      try {
        if (binary) {
          Y.applyUpdate(document, new Uint8Array(data));
          return;
        }
        const message = validateServerMessage(JSON.parse(data.toString('utf8')));
        if (!synced && message.type === 'error' && message.code === 'DOCUMENT_NOT_INITIALISED') {
          throw new CliError('DOCUMENT_NOT_INITIALISED', String(message.message), 409);
        }
        if (message.type === 'synced' && !synced) {
          synced = true;
          if (
            message.protocol !== PROTOCOL_VERSION ||
            (writing ? message.automationWrites !== true : message.automationReadOnly !== true) ||
            message.documentId !== documentId
          ) {
            throw new CliError('UNSUPPORTED_SERVER', 'Update the Hub server to use the CLI.', 409);
          }
          const write = (payload) =>
            new Promise((resolve) => {
              signal.throwIfAborted();
              sentRequest = payload.requestId;
              resolveWrite = resolve;
              socket.send(JSON.stringify(payload), (error) => {
                if (error) finish(disconnected());
              });
            });
          if (historyId) {
            recheck();
            socket.send(JSON.stringify({ type: 'history-get', id: historyId }), (error) => {
              if (error) finish(disconnected());
            });
          } else {
            Promise.resolve(operation(document, message, writing ? write : undefined)).then(
              (value) => finish(null, value),
              finish,
            );
          }
        } else if (synced && historyId && message.type === 'history-version' && message.id === historyId) {
          recheck();
          finish(null, { id: historyId, text: Buffer.from(String(message.textBase64), 'base64').toString('utf8') });
        } else if (synced && historyId && message.type === 'error') {
          finish(new CliError('HISTORY_UNAVAILABLE', String(message.message), 404));
        } else if (message.type === 'discussion-result' && sentRequest && message.requestId === sentRequest) {
          resolveWrite(message);
        }
      } catch (error) {
        finish(error);
      }
    });
    if (signal.aborted) abort();
  });
}
