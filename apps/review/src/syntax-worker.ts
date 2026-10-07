import { parseLocalisationDiagnostics } from '../../../packages/shared/src/localisation-syntax.mts';
import type { LocalisationDiagnostic } from '../../../packages/shared/src/localisation-syntax.mts';
import { localisationLanguage } from '../../../packages/shared/src/localisation-records.mts';

interface KeyIndexPayload {
  complete?: boolean;
  error?: string;
  languages?: Record<string, { complete?: boolean; keys?: string[] }>;
  scripted?: { complete?: boolean; definitions?: { name: string }[] };
  documentedGetters?: string[];
}

type WorkerRequest =
  | { type: 'init-key-index'; token: string }
  | { type?: string; id: number; version: number; text: string; filePath?: string };

let indexTimer: ReturnType<typeof setInterval> | null = null;
let indexError = '';
let indexTag = '';
let languageKeys: Map<string, Set<string>> | null = null;
let languagePrefixes = new Map<string, Set<string>>();
let knownGetters: Set<string> | null = null;
let token = '';
let currentPath = '';
const diskChecks = new Map<string, { time: number; diagnostics: LocalisationDiagnostic[]; pending: boolean }>();

function prefixesFor(keys: ReadonlySet<string>): Set<string> {
  return new Set([...keys].map((key) => /^([A-Z0-9]{2,5})_/u.exec(key)?.[1])
    .filter((prefix): prefix is string => Boolean(prefix)));
}

async function refreshDisk(filePath: string): Promise<void> {
  if (!token || !filePath) return;
  const cached = diskChecks.get(filePath);
  if (cached?.pending || (cached && Date.now() - cached.time < 10_000)) return;
  const entry = { time: Date.now(), diagnostics: cached?.diagnostics ?? [], pending: true };
  // Reinsert so the eviction below removes the least recently checked tab.
  diskChecks.delete(filePath); diskChecks.set(filePath, entry);
  // Only recently visible tabs need byte checks. Keep the worker cache bounded.
  if (diskChecks.size > 32) diskChecks.delete(diskChecks.keys().next().value!);
  try {
    const query = new URLSearchParams({ path: filePath });
    const response = await fetch(`/api/localisation-file-diagnostics?${query}`, {
      cache: 'no-store', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { diagnostics?: LocalisationDiagnostic[] };
    const next = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    const changed = JSON.stringify(next) !== JSON.stringify(entry.diagnostics);
    entry.diagnostics = next;
    if (changed && currentPath === filePath) self.postMessage({ type: 'disk-diagnostics-ready' });
  } catch {
    // Missing/unmaterialised files cannot prove a byte-level failure. Never
    // retain stale errors after deletion or replacement of the local file.
    const changed = entry.diagnostics.length > 0;
    entry.diagnostics = [];
    if (changed && currentPath === filePath) self.postMessage({ type: 'disk-diagnostics-ready' });
  } finally { entry.pending = false; entry.time = Date.now(); }
}

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
    languageKeys = payload.languages && payload.complete
      ? new Map(Object.entries(payload.languages).filter(([, value]) => value.complete && Array.isArray(value.keys))
        .map(([language, value]) => [language, new Set(value.keys!)])) : null;
    languagePrefixes = new Map([...(languageKeys ?? [])].map(([language, keys]) => [language, prefixesFor(keys)]));
    knownGetters = payload.scripted?.complete
      ? new Set([...(payload.documentedGetters ?? []), ...(payload.scripted.definitions ?? []).map((item) => item.name)]) : null;
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
    token = data.token;
    if (indexTimer) clearInterval(indexTimer);
    refreshKeyIndex(data.token);
    indexTimer = setInterval(() => { refreshKeyIndex(data.token); refreshDisk(currentPath); }, 60_000);
    return;
  }
  try {
    if ('id' in data) {
      currentPath = data.filePath ?? '';
      refreshDisk(currentPath);
      const language = localisationLanguage(currentPath, data.text);
      // Keys resolve only within the file's language. A language absent from the
      // inventory, or a file without one, proves nothing about missing keys.
      const keys = language ? languageKeys?.get(language) ?? null : null;
      const prefixes = language ? languagePrefixes.get(language) ?? null : null;
      self.postMessage({ id: data.id, version: data.version,
        diagnostics: [...parseLocalisationDiagnostics(data.text, { filePath: data.filePath,
          knownKeys: keys, knownPrefixes: prefixes, knownGetters }), ...(diskChecks.get(currentPath)?.diagnostics ?? [])] });
    }
  } catch (error) {
    if ('id' in data) self.postMessage({ id: data.id, version: data.version, error: errorMessage(error) });
  }
};
