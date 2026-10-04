import type { AgentConnectionOptions } from './agent-connection.ts';

export const WORKSPACE_BRIDGE = 'eaw-review-workspace-v1';
export function embeddedSessionId(): string {
  return typeof window !== 'undefined' && window.parent !== window ? new URLSearchParams(location.hash.slice(1)).get('session') ?? '' : '';
}
export function postWorkspace(operation: string, payload: Record<string, unknown> = {}) {
  const sessionId = embeddedSessionId();
  if (sessionId) window.parent.postMessage({ bridge:WORKSPACE_BRIDGE, sessionId, operation, ...payload }, location.origin);
}
export function createEmbeddedConnection(options: AgentConnectionOptions) {
  let connected = false, disposed = false;
  const waiters = new Map<string,() => void>();
  const receive = (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.bridge !== WORKSPACE_BRIDGE
      || event.data.sessionId !== embeddedSessionId() || disposed) return;
    const message = event.data;
    if (message.operation === 'opened') { connected = true; options.onOpen(); }
    else if (message.operation === 'waiting') { connected = false; options.onWaiting(message.delay ?? 0, message.error); }
    else if (message.operation === 'message') options.onMessage(message.message);
    else if (message.operation === 'flushed') waiters.get(message.requestId)?.();
  };
  window.addEventListener('message', receive);
  postWorkspace('connect');
  return {
    send(message: unknown) { if (!connected || disposed) return false; postWorkspace('send', {message}); return true; },
    async flush(timeoutMilliseconds = 500) {
      if (!connected || disposed) return;
      await new Promise<void>(resolve => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => finish(),timeoutMilliseconds);
        function finish() { clearTimeout(timer); waiters.delete(requestId); resolve(); }
        waiters.set(requestId,finish); postWorkspace('flush',{requestId,timeoutMilliseconds});
      });
    },
    dispose() { disposed = true; connected = false; for (const finish of waiters.values()) finish(); window.removeEventListener('message', receive); postWorkspace('disconnect'); },
  };
}
