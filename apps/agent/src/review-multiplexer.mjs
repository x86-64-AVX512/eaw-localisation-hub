import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES } from '../../../packages/shared/src/constants.mts';

class ChannelSocket extends EventEmitter {
  constructor(physical, send, close) { super(); this.physical = physical; this.outbound = send; this.shutdown = close; this.open = true; }
  get readyState() { return this.open ? this.physical.readyState : WebSocket.CLOSED; }
  send(text) { this.outbound(JSON.parse(text)); }
  close() { this.shutdown(); }
  terminate() { this.shutdown(); }
}

export function reviewSleepBlocked(client, hub) {
  if (client.closed || hub.closing || hub.workspaceBlocked || hub.workspaceTransitioning
    || hub.gitCommitCheckPending || hub.gitOperationInProgress?.() || !client.documents.size
    || client.materialisationTimers?.size) return true;
  for (const state of client.documents.values()) {
    const b = state.binding;
    if (!state.initialised || !state.initialReconciled || state.pendingExternal
      || b.closing || b.paused || !b.synced || b.localUpdatePending || b.deliveryFailed || b.flushWaiter
      || b.personalRequestId || b.personalRefreshPending || b.personalRefreshTimer || b.materialisationActive
      || b.personalSelectionStale || b.personalConflicts?.length || b.personalGitConflicts?.length
      || b.gitState?.status === 'conflict' || b.socket?.bufferedAmount > 0) return true;
    if (!b.ticketId && (!b.personalReady || (b.gitWritable && b.localFileText?.() !== state.diskBase))) return true;
  }
  return false;
}

/** Local-only framing. Each document runtime has its own authenticated logical
 * client, including same-path tickets; the public EHSP protocol is unchanged. */
export function attachReviewMultiplexer(socket, hub, createClient) {
  const channels = new Map();
  const connectionId = Symbol('review-workspace');
  let active = '';
  const send = value => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  function remove(id, reason = 'closed') {
    const channel = channels.get(id);
    if (!channel) return;
    channels.delete(id); channel.socket.open = false; channel.socket.emit('close');
    send({ type: 'reviewSessionClosed', sessionId: id, reason });
  }
  function select(id) {
    if (active !== id) {
      const previous = channels.get(active)?.client;
      if (previous?.activeDocumentPath) hub.receiveClientMessage(previous, { type:'deactivate', path:previous.activeDocumentPath });
    }
    active = id;
  }
  socket.on('message', async (data, binary) => {
    try {
      if (binary || data.length > MAX_MESSAGE_BYTES) throw new Error('Invalid frame');
      const frame = JSON.parse(data.toString('utf8'));
      const id = frame.sessionId;
      if (frame.type !== 'reviewSession' || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/u.test(id)) throw new Error('Invalid session');
      if (frame.operation === 'select') { select(id); return; }
      if (frame.operation === 'open') {
        if (channels.has(id)) return;
        if (channels.size >= 20) { send({ type:'reviewSessionClosed', sessionId:id, reason:'limit' }); return; }
        const channel = { socket:new ChannelSocket(socket,
          message => send({ type:'reviewSessionMessage',sessionId:id,message }), () => remove(id)), client:null, epoch:0, sleeping:false };
        const virtual = channel.socket;
        channel.client = createClient(virtual); channel.client.connectionId = connectionId;
        channels.set(id, channel);
        if (!hub.attachAuthenticatedClient(channel.client)) { remove(id, 'limit'); return; }
        send({ type:'reviewSessionOpened', sessionId:id }); return;
      }
      const channel = channels.get(id);
      if (!channel) return;
      if (frame.operation === 'close') { remove(id); return; }
      if (frame.operation === 'message') {
        channel.epoch++;
        if (id !== active && ['activate','cursor'].includes(frame.message?.type)) return;
        if (id === active && frame.message?.type === 'activate') select(id);
        channel.socket.emit('message', Buffer.from(JSON.stringify(frame.message)), false); return;
      }
      if (frame.operation === 'sleep') {
        if (channel.sleeping) return;
        channel.sleeping = true;
        const epoch = channel.epoch;
        const blocked = () => active === id || channels.get(id) !== channel || channel.epoch !== epoch || reviewSleepBlocked(channel.client, hub);
        try {
          if (!blocked()) {
            await Promise.all([...channel.client.documents.values()].map(state => state.diskCheckPromise));
            if (!blocked()) {
              const confirmed = await Promise.all([...channel.client.documents.values()].map(state => state.binding.flushToServer()));
              if (confirmed.every(Boolean) && !blocked()) { remove(id, 'sleep'); return; }
            }
          }
          send({ type:'reviewSessionSleepDenied', sessionId:id });
        } catch { send({ type:'reviewSessionSleepDenied', sessionId:id }); }
        finally { channel.sleeping = false; }
        return;
      }
      throw new Error('Invalid operation');
    } catch { socket.close(1008, 'Invalid workspace command'); }
  });
  socket.on('close', () => { for (const id of [...channels.keys()]) remove(id); });
  socket.on('error', () => socket.close());
  return { channels };
}
