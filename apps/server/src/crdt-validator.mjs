import { Worker } from 'node:worker_threads';

const MAX_PENDING_VALIDATIONS = 64;
const BASE_TIMEOUT_MILLISECONDS = 500;
const MAX_TIMEOUT_MILLISECONDS = 1500;

export class CrdtValidationError extends Error {
  constructor(message, code = 'invalid-crdt-update') {
    super(message);
    this.name = 'CrdtValidationError';
    this.code = code;
  }
}

export class CrdtUpdateValidator {
  constructor({ maximumStateBytes }) {
    this.maximumStateBytes = maximumStateBytes;
    this.worker = null;
    this.nextId = 1;
    this.queue = [];
    this.current = null;
    this.closed = false;
  }

  validate(update, baseUpdate = null) {
    if (this.closed) return Promise.reject(new CrdtValidationError('CRDT validator is closed'));
    if (this.queue.length + (this.current ? 1 : 0) >= MAX_PENDING_VALIDATIONS) {
      return Promise.reject(new CrdtValidationError('CRDT validation queue is full', 'crdt-validation-overloaded'));
    }
    const updateCopy = Uint8Array.from(update);
    const baseCopy = baseUpdate?.byteLength ? Uint8Array.from(baseUpdate) : null;
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, update: updateCopy, baseUpdate: baseCopy, resolve, reject });
      this.#dispatch();
    });
  }

  async close() {
    this.closed = true;
    const error = new CrdtValidationError('CRDT validator is shutting down');
    for (const job of this.queue.splice(0)) job.reject(error);
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(error);
      this.current = null;
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  #ensureWorker() {
    if (this.worker) return;
    const worker = new Worker(new URL('./crdt-validator-worker.mjs', import.meta.url));
    worker.on('message', (message) => this.#complete(message));
    worker.on('error', () => this.#restart('CRDT validation worker failed'));
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0 && this.worker === worker) this.#restart('CRDT validation worker exited');
    });
    this.worker = worker;
  }

  #dispatch() {
    if (this.closed || this.current || this.queue.length === 0) return;
    this.#ensureWorker();
    const job = this.queue.shift();
    const totalBytes = job.update.byteLength + (job.baseUpdate?.byteLength ?? 0);
    const timeoutMilliseconds = Math.min(
      MAX_TIMEOUT_MILLISECONDS,
      BASE_TIMEOUT_MILLISECONDS + Math.ceil(totalBytes / (1024 * 1024)) * 100,
    );
    job.timer = setTimeout(() => this.#restart('CRDT update validation timed out', 'crdt-validation-timeout'), timeoutMilliseconds);
    job.timer.unref?.();
    this.current = job;
    const transfers = [job.update.buffer];
    if (job.baseUpdate) transfers.push(job.baseUpdate.buffer);
    this.worker.postMessage({ id: job.id, update: job.update, baseUpdate: job.baseUpdate }, transfers);
  }

  #complete(message) {
    const job = this.current;
    if (!job || message?.id !== job.id) return;
    clearTimeout(job.timer);
    this.current = null;
    if (!message.ok) job.reject(new CrdtValidationError('CRDT update is malformed'));
    else if (!Number.isSafeInteger(message.stateBytes) || message.stateBytes > this.maximumStateBytes) {
      job.reject(new CrdtValidationError('CRDT update expands beyond the accepted state limit'));
    } else job.resolve({ stateBytes: message.stateBytes, elapsedMilliseconds: message.elapsedMilliseconds });
    this.#dispatch();
  }

  #restart(message, code = 'crdt-validation-worker-failed') {
    const worker = this.worker;
    this.worker = null;
    if (worker) worker.terminate().catch(() => {});
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(new CrdtValidationError(message, code));
      this.current = null;
    }
    this.#dispatch();
  }
}
