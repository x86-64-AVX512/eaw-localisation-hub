export function createAgentConnection({ token, onMessage, onOpen, onWaiting }) {
  let socket = null;
  let retryTimer = 0;
  let retryDelay = 500;
  let disposed = false;

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
    dispose() {
      disposed = true;
      window.clearTimeout(retryTimer);
      retryTimer = 0;
      window.removeEventListener('online', connect);
      socket?.close();
    },
  };
}
