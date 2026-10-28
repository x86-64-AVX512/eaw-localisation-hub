import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { MAX_MESSAGE_BYTES } from '../../../packages/shared/src/constants.mts';
import { validateServerMessage } from '../../../packages/shared/src/protocol-schema.mts';
import { appendGitHead } from './git-document-state.mjs';
import { rejectDiskMergeRequests } from './disk-merge-request.mjs';
import { handleSocketClose } from './document-delivery.mts';
import { resetPersonalRequest } from './personal-document.mjs';
import { handleMergedBranchClose, handleUnavailableTicketClose } from './document-lifecycle.mts';

export function scheduleDocumentReconnect(binding) {
  if (binding.reconnectTimer || binding.closing || binding.paused) return;
  const delay = binding.reconnectDelay ?? 500;
  binding.reconnectDelay = Math.min(5000, Math.round(delay * 1.7));
  binding.reconnectTimer = setTimeout(() => { binding.reconnectTimer = null; binding.connect(); }, delay);
  binding.reconnectTimer.unref?.();
}

export function connectDocument(binding, remoteOrigin) {
  if (binding.paused || binding.closing || binding.socket?.readyState <= WebSocket.OPEN) return;
  binding.stopConnectionWatchdog?.();
  const policy = binding.hub.options.connectionPolicy ?? {};
  const url = new URL(binding.hub.options.server);
  url.searchParams.set('document', binding.documentId); appendGitHead(binding, url);
  const headers = binding.hub.options.token ? {Authorization:`Bearer ${binding.hub.options.token}`} : undefined;
  binding.serverStateVector = null;
  const socket = new WebSocket(url, {maxPayload:MAX_MESSAGE_BYTES,headers,handshakeTimeout:policy.handshakeMs ?? 8000});
  binding.socket = socket; socket.binaryType = 'arraybuffer';
  const syncMs = policy.syncMs ?? 15000, pingMs = policy.pingMs ?? 10000, pongMs = policy.pongMs ?? 5000;
  // A large frame (up to 12 MiB) can take longer than any of these limits on a weak
  // link, and a pong only follows it. So every received byte counts as progress and
  // only a silent connection times out, never a long transfer.
  let lastBytes = Date.now(), pingedAt = 0, watchdog;
  const received = () => { lastBytes = Date.now(); };
  // Listen only after ws attached its own reader at 'open': a listener added earlier
  // would take the bytes ws pushes back right after the handshake, and ws would lose them.
  let transport = null;
  socket.on('upgrade', response => { transport = response.socket; });
  const stop = () => clearInterval(watchdog);
  binding.stopConnectionWatchdog = stop;
  const expire = stage => {
    if (binding.socket !== socket || binding.closing || binding.paused) return;
    console.warn(`[agent] document ${stage} timed out`); stop(); socket.terminate();
  };
  socket.on('open', () => {
    if (binding.socket !== socket) return;
    console.log('[agent] document connected'); binding.emitDocumentStatus('syncing');
    received(); transport?.on('data', received);
    watchdog = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const silent = Date.now() - lastBytes;
      // No pings before sync: a pong would hide a server that never starts sending.
      if (!binding.synced) { if (silent >= syncMs) expire('sync'); return; }
      if (silent >= pingMs + pongMs) expire('heartbeat');
      else if (silent >= pingMs && pingedAt <= lastBytes) {
        pingedAt = Date.now();
        try { socket.ping(); } catch { expire('heartbeat'); }
      }
    }, Math.max(10, Math.min(syncMs, pingMs, pongMs) / 4));
    watchdog.unref?.();
  });
  socket.on('pong', received);
  socket.on('message', (data,isBinary) => {
    if (binding.socket !== socket) return;
    try {
      if (isBinary) {
        const update = new Uint8Array(data);
        if (!binding.synced) binding.serverStateVector = Y.encodeStateVectorFromUpdate(update);
        Y.applyUpdate(binding.document,update,remoteOrigin);
      } else binding.receiveServerMessage(validateServerMessage(JSON.parse(data.toString('utf8'))));
      if (binding.synced) binding.reconnectDelay=500;
    } catch {console.error('[agent] server message failed');}
  });
  socket.on('close',(code,reason)=>{
    stop(); if (binding.socket !== socket) return;
    rejectDiskMergeRequests(binding); handleSocketClose(binding); binding.synced=false;resetPersonalRequest(binding);
    console.warn('[agent] document disconnected');
    const detail = reason?.toString('utf8') || '';
    if (handleMergedBranchClose(binding,code) || handleUnavailableTicketClose(binding,code,detail)) return;
    if (code === 1008) {
      binding.paused=true;binding.emitDocumentStatus('unauthorized');
      for (const client of binding.clients) client.send({type:'notice',message:`Сервер отклонил авторизацию: ${detail || 'Authentication failed'}. Перезапустите Agent после входа.`});
      return;
    }
    binding.emitDocumentStatus('offline');binding.scheduleReconnect();
  });
  socket.on('error',()=>console.error('[agent] websocket error'));
}
