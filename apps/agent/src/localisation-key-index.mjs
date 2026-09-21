import path from 'node:path';
import { Worker } from 'node:worker_threads';

const cache = new Map();
const MAX_AGE_MS = 60_000;

function createEntry(repository) {
  const worker = new Worker(new URL('./localisation-key-index-worker.mjs', import.meta.url), {
    workerData: { repository },
  });
  const entry = { worker, repository, result: null, startedAt: 0, nextId: 0, pending: null };
  worker.unref();
  function fail(error) {
    if (cache.get(repository) === entry) cache.delete(repository);
    if (entry.pending) {
      clearTimeout(entry.pending.timer);
      entry.pending.reject(error);
      entry.pending = null;
    }
    worker.terminate().catch(() => {});
  }
  worker.on('message', ({ id, error, result, unchanged }) => {
    const pending = entry.pending;
    if (!pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    entry.pending = null;
    worker.unref();
    if (error) { fail(new Error(error)); pending.reject(new Error(error)); return; }
    if (!unchanged) entry.result = result;
    pending.resolve(entry.result);
  });
  worker.on('error', (error) => fail(error));
  worker.on('exit', (code) => {
    if (cache.get(repository) === entry) fail(new Error(`Localisation key index exited with code ${code}`));
  });
  return entry;
}

export function getLocalisationKeyIndex(repository, { forceRefresh = false } = {}) {
  const key = path.resolve(repository);
  let entry = cache.get(key);
  if (!entry) { entry = createEntry(key); cache.set(key, entry); }
  if (entry.pending) return entry.pending.promise;
  if (!forceRefresh && entry.result && Date.now() - entry.startedAt < MAX_AGE_MS) {
    return Promise.resolve(entry.result);
  }
  const id = ++entry.nextId;
  entry.startedAt = Date.now();
  let resolvePending; let rejectPending;
  const promise = new Promise((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
  const timer = setTimeout(() => {
    const pending = entry.pending;
    if (!pending || pending.id !== id) return;
    entry.pending = null;
    cache.delete(key);
    entry.worker.terminate().catch(() => {});
    pending.reject(new Error('Localisation key index timed out'));
  }, 30_000);
  timer.unref?.();
  entry.pending = { id, promise, resolve: resolvePending, reject: rejectPending, timer };
  entry.worker.ref();
  entry.worker.postMessage({ id });
  return promise;
}
