// WebSocket.OPEN (1); keep this leaf independent of ws runtime type declarations.
const SOCKET_OPEN = 1;

interface PresenceBinding {
  hub: { presenceClientId: string };
  socket: { readyState: number; send(data: string): void } | null;
  synced: boolean;
}

interface PresenceClient {
  clientId: string;
}

type PresenceEntry = Record<string, unknown> & {
  clientId: string;
  sequence: number;
};

export class LocalPresenceMux {
  binding: PresenceBinding;
  entries: Map<string, PresenceEntry>;
  sequence: number;

  constructor(binding: PresenceBinding) {
    this.binding = binding;
    this.entries = new Map<string, PresenceEntry>();
    this.sequence = 0;
  }

  update(client: PresenceClient, payload: Record<string, unknown>): void {
    this.entries.set(client.clientId, {
      ...payload,
      clientId: this.binding.hub.presenceClientId,
      sequence: ++this.sequence,
    });
    this.publish();
  }

  remove(client: PresenceClient): void {
    if (!this.entries.delete(client.clientId)) return;
    this.publish();
  }

  current(): PresenceEntry | null {
    return [...this.entries.values()].sort((left, right) => right.sequence - left.sequence)[0] ?? null;
  }

  publish(): void {
    const { socket, synced, hub } = this.binding;
    if (!synced || !socket || socket.readyState !== SOCKET_OPEN) return;
    const current = this.current();
    socket.send(JSON.stringify(current ?? {
      type: 'presence', clientId: hub.presenceClientId, offline: true,
    }));
  }

  replay(): void {
    this.publish();
  }

  clear(): void {
    this.entries.clear();
  }
}
