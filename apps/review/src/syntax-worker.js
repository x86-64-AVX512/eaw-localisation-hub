import { parseLocalisationDiagnostics } from '../../../packages/shared/src/localisation-syntax.mjs';

let knownKeys = null;
let knownPrefixes = null;
let indexTimer = null;
let indexError = '';

async function refreshKeyIndex(token) {
  try {
    const response = await fetch('/api/localisation-key-index', {
      cache: 'no-store', headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    knownKeys = payload.complete && Array.isArray(payload.keys) ? new Set(payload.keys) : null;
    knownPrefixes = knownKeys
      ? new Set([...knownKeys].map((key) => /^([A-Z0-9]{2,5})_/u.exec(key)?.[1]).filter(Boolean))
      : null;
    indexError = '';
    self.postMessage({ type: 'key-index-ready' });
  } catch (error) {
    if (indexError === error.message) return;
    indexError = error.message;
    self.postMessage({ type: 'key-index-error', error: error.message });
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'init-key-index') {
    if (indexTimer) clearInterval(indexTimer);
    refreshKeyIndex(data.token);
    indexTimer = setInterval(() => refreshKeyIndex(data.token), 60_000);
    return;
  }
  try {
    self.postMessage({ id: data.id, version: data.version,
      diagnostics: parseLocalisationDiagnostics(data.text, { filePath: data.filePath, knownKeys, knownPrefixes }) });
  } catch (error) {
    self.postMessage({ id: data.id, version: data.version, error: error.message });
  }
};
