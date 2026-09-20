import path from 'node:path';
import { Worker } from 'node:worker_threads';

const cache = new Map();
const MAX_AGE_MS = 60_000;

export function getLocalisationKeyIndex(repository) {
  const key = path.resolve(repository);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.startedAt < MAX_AGE_MS) return existing.promise;
  const promise = new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./localisation-key-index-worker.mjs', import.meta.url), {
      workerData: { repository: key },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Localisation key index timed out')), 30_000);
    timer.unref?.();
    worker.once('message', ({ error, result }) => finish(error ? new Error(error) : null, result));
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(new Error(`Localisation key index exited with code ${code}`));
    });
  });
  const entry = { startedAt: Date.now(), promise };
  cache.set(key, entry);
  promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return promise;
}
