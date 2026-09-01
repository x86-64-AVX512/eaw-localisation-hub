import { WebSocket } from 'ws';

export class LocalPresenceMux {
  constructor(binding) {
    this.binding = binding;
    this.entries = new Map();
    this.sequence = 0;
  }

  update(client, payload) {
    this.entries.set(client.clientId, {
      ...payload,
      clientId: this.binding.hub.presenceClientId,
      priority: client.kind === 'review' ? 1 : 0,
      sequence: ++this.sequence,
    });
    this.publish();
  }

  remove(client) {
    if (!this.entries.delete(client.clientId)) return;
    this.publish();
  }

  current() {
    return [...this.entries.values()].sort((left, right) =>
      right.priority - left.priority || right.sequence - left.sequence)[0] ?? null;
  }

  publish() {
    const { socket, synced, hub } = this.binding;
    if (!synced || socket?.readyState !== WebSocket.OPEN) return;
    const current = this.current();
    socket.send(JSON.stringify(current ?? {
      type: 'presence', clientId: hub.presenceClientId, offline: true,
    }));
  }

  replay() {
    this.publish();
  }

  clear() {
    this.entries.clear();
  }
}
