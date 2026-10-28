import { Buffer } from 'node:buffer';
import { serverHttpUrl } from './server-http-url.mts';

// Server work such as applying a ticket happens before the response headers, and its
// request body may be large; such routes pass a longer `timeoutMilliseconds`.
export const SLOW_SERVER_OPERATION_MILLISECONDS = 120000;

// Times out a stalled exchange, not a slow one: the deadline covers waiting for the
// headers, then restarts on every received body chunk, so a large snapshot on a weak
// link still arrives. No automatic retry: a timed-out POST may already have been applied.
export async function requestAgentJson(options, route, init = {}, lifetimeSignal) {
  const { signal, headers, timeoutMilliseconds, ...request } = init;
  const idleMilliseconds = options.httpTimeoutMilliseconds ?? 8000;
  const deadline = new AbortController();
  let timer;
  const arm = (milliseconds) => {
    clearTimeout(timer);
    timer = setTimeout(() => deadline.abort(), milliseconds);
  };
  const combined = AbortSignal.any([lifetimeSignal, signal, deadline.signal].filter(Boolean));
  arm(timeoutMilliseconds ?? idleMilliseconds);
  try {
    const response = await fetch(serverHttpUrl(options.server, route), {
      ...request, signal: combined,
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', ...(headers ?? {}) },
    });
    arm(idleMilliseconds);
    const chunks = [];
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      arm(idleMilliseconds);
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { payload = {}; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Authentication API returned a non-object response');
    if (!response.ok) throw new Error(String(payload.error || `Authentication API failed with HTTP ${response.status}`));
    return payload;
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new Error('Не удалось получить ответ сервера вовремя. Результат операции не подтверждён.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
