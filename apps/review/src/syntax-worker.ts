import { parseLocalisationDiagnostics } from '../../../packages/shared/src/localisation-syntax.mts';

interface KeyIndexPayload {
  complete?: boolean;
  keys?: string[];
  error?: string;
}

type WorkerRequest =
  | { type: 'init-key-index'; token: string }
  | { type?: string; id: number; version: number; text: string; filePath?: string };

let knownKeys: Set<string> | null = null;
let knownPrefixes: Set<string> | null = null;
let indexTimer: ReturnType<typeof setInterval> | null = null;
let indexError = '';
let indexTag = '';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshKeyIndex(token: string): Promise<void> {
  try {
    const response = await fetch('/api/localisation-key-index', {
      cache: 'no-store', headers: { Authorization: `Bearer ${token}`,
        ...(indexTag ? { 'If-None-Match': indexTag } : {}) },
    });
    if (response.status === 304) return;
    const payload = await response.json() as KeyIndexPayload;
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    indexTag = response.headers?.get?.('etag') ?? '';
    knownKeys = payload.complete && Array.isArray(payload.keys) ? new Set(payload.keys) : null;
    knownPrefixes = knownKeys
      ? new Set([...knownKeys].map((key) => /^([A-Z0-9]{2,5})_/u.exec(key)?.[1])
        .filter((prefix): prefix is string => Boolean(prefix)))
      : null;
    indexError = '';
    self.postMessage({ type: 'key-index-ready' });
  } catch (error) {
    const message = errorMessage(error);
    if (indexError === message) return;
    indexError = message;
    self.postMessage({ type: 'key-index-error', error: message });
  }
}

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'init-key-index' && 'token' in data) {
    if (indexTimer) clearInterval(indexTimer);
    refreshKeyIndex(data.token);
    indexTimer = setInterval(() => refreshKeyIndex(data.token), 60_000);
    return;
  }
  try {
    if ('id' in data) {
      self.postMessage({ id: data.id, version: data.version,
        diagnostics: parseLocalisationDiagnostics(data.text, { filePath: data.filePath, knownKeys, knownPrefixes }) });
    }
  } catch (error) {
    if ('id' in data) self.postMessage({ id: data.id, version: data.version, error: errorMessage(error) });
  }
};
