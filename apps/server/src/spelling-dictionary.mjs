import { Worker } from 'node:worker_threads';

let payloadPromise = null;

function buildPayload() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./spelling-dictionary-worker.mjs', import.meta.url));
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };
    worker.once('message', (message) => {
      if (message?.error) finish(reject, new Error(message.error));
      else finish(resolve, Object.freeze(message.payload));
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`Dictionary worker stopped with code ${code}`));
    });
  });
}

export function russianDictionaryPayload() {
  if (!payloadPromise) payloadPromise = buildPayload().catch((error) => {
    payloadPromise = null;
    throw error;
  });
  return payloadPromise;
}
