export function createAgentConnection({ token, onMessage, onOpen, onWaiting }) {
  let socket = null;
  let retryTimer = 0;
  let retryDelay = 500;
  let disposed = false;

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  async function flush(timeoutMilliseconds = 500) {
    const activeSocket = socket;
    if (activeSocket?.readyState !== WebSocket.OPEN) return;
    const deadline = performance.now() + timeoutMilliseconds;
    do {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    } while (activeSocket.readyState === WebSocket.OPEN
      && activeSocket.bufferedAmount > 0 && performance.now() < deadline);
  }

  function schedule() {
    if (disposed || retryTimer) return;
    onWaiting(retryDelay);
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      connect();
    }, retryDelay);
    retryDelay = Math.min(5000, Math.round(retryDelay * 1.7));
  }

  function connect() {
    if (disposed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    socket = new WebSocket(`ws://${location.host}/review-socket?token=${encodeURIComponent(token)}`);
    socket.addEventListener('message', (event) => {
      try { onMessage(JSON.parse(event.data)); }
      catch { onWaiting(0, 'Получено некорректное сообщение Agent.'); }
    });
    socket.addEventListener('open', () => {
      retryDelay = 500;
      onOpen();
    });
    socket.addEventListener('close', schedule);
    socket.addEventListener('error', () => socket?.close());
  }

  window.addEventListener('online', connect);
  connect();
  return {
    send,
    flush,
    dispose() {
      disposed = true;
      window.clearTimeout(retryTimer);
      retryTimer = 0;
      window.removeEventListener('online', connect);
      socket?.close();
    },
  };
}
