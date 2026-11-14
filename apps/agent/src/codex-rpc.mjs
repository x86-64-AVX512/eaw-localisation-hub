import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { DISPLAY_VERSION } from '../../../packages/shared/src/constants.mts';
import { codexExecutable } from './codex-executable.mjs';

export function codexFailure(text) {
  if (/rate.limit|usage.limit|quota/iu.test(text)) return new Error('Достигнут лимит Codex. Повторите запрос позже.');
  if (/unauthorized|not.logged|sign.in|401/iu.test(text)) return new Error('Войдите в Codex CLI через свой аккаунт ChatGPT.');
  if (/model.*(?:not|unsupported|unavailable)/iu.test(text)) return new Error('GPT-6 Luna недоступна этому аккаунту.');
  return new Error('Запрос Codex завершился с ошибкой. Проверьте вход и подключение к сети.');
}

// One local process per Review server. Only newline-delimited JSON-RPC crosses
// this boundary; model output never becomes a shell command or executable path.
export class CodexRpc {
  pending = new Map();
  listeners = new Set();
  sequence = 0;
  closed = false;

  constructor({ cwd, config, profileDirectory, spawnProcess = spawn, executable = codexExecutable() }) {
    this.cwd = cwd;
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    const env = { ...process.env };
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_THREAD_ID', 'CODEX_PARENT_THREAD_ID']) delete env[name];
    if (profileDirectory) env.CODEX_HOME = profileDirectory;
    this.child = spawnProcess(executable, args,
      { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', () => {});
    this.child.once('error', error => this.close('code' in error && error.code === 'ENOENT'
      ? new Error('Codex CLI не найден. Установите Codex CLI и войдите через ChatGPT.') : codexFailure('')));
    this.child.once('close', () => this.close(codexFailure('')));
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try {
        if (Buffer.byteLength(line) > 512 * 1024) throw new Error('Ответ Codex слишком большой.');
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          this.send({ id: message.id, error: { code: -32601, message: 'Interactive tools are disabled in this client.' } });
        } else if (message.id !== undefined) {
          const handler = this.pending.get(message.id);
          if (!handler) return;
          message.error ? handler.reject(codexFailure(message.error.message ?? '')) : handler.resolve(message.result);
        } else {
          for (const listener of this.listeners) listener(message);
        }
      } catch (error) { this.close(error instanceof SyntaxError ? codexFailure('') : error); }
    });
  }

  send(message) {
    if (this.closed) throw codexFailure('');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  call(method, params, signal, timeoutMs = 10_000) {
    if (this.closed) return Promise.reject(codexFailure(''));
    if (signal?.aborted) return Promise.reject(new Error('Запрос ИИ отменён.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
      };
      const abort = () => { cleanup(); reject(new Error('Запрос ИИ отменён.')); };
      const timer = setTimeout(() => {
        cleanup(); reject(new Error('Превышено время ожидания Codex. Повторите запрос.'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.send({ id, method, params }); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  async initialise(signal) {
    await this.call('initialize', { clientInfo: { name: 'eaw_localisation_hub', title: 'EaW Localisation Hub', version: DISPLAY_VERSION } }, signal);
    this.send({ method: 'initialized' });
  }

  generate(threadId, input, outputSchema, model, signal) {
    if (this.closed) return Promise.reject(codexFailure(''));
    if (signal?.aborted) return Promise.reject(new Error('Запрос ИИ отменён.'));
    return new Promise((resolve, reject) => {
      let text = '', usage = null, contextWindow = null;
      let turnId = null;
      const beforeAcknowledgement = [];
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.listeners.delete(receive);
        this.listeners.delete(onClose);
      };
      const fail = error => { cleanup(); reject(error); };
      const abort = () => this.close(new Error('Запрос ИИ отменён.'));
      const onClose = message => { if (message.method === 'local/closed') fail(message.error); };
      const receive = message => {
        if (message.params?.threadId !== threadId) return;
        if (!['item/completed', 'thread/tokenUsage/updated', 'turn/completed'].includes(message.method)) return;
        if (turnId === null) { beforeAcknowledgement.push(message); return; }
        const eventTurn = message.params.turnId ?? message.params.turn?.id;
        if (eventTurn !== turnId) return;
        if (message.method === 'item/completed' && message.params.item?.type === 'agentMessage') {
          text = message.params.item.text;
          if (Buffer.byteLength(text) > 256 * 1024) this.close(new Error('Ответ Codex слишком большой.'));
        } else if (message.method === 'thread/tokenUsage/updated') {
          usage = message.params.tokenUsage?.last;
          contextWindow = message.params.tokenUsage?.modelContextWindow;
        }
        else if (message.method === 'turn/completed') {
          const turn = message.params.turn;
          cleanup();
          if (turn.status === 'completed' && text) resolve({ text, usage, ...(contextWindow > 0 ? { contextWindow } : {}) });
          else reject(codexFailure(turn.error?.message ?? ''));
        }
      };
      const timer = setTimeout(() => this.close(new Error('Превышено время ожидания Codex. Повторите запрос.')), 60_000);
      this.listeners.add(receive);
      this.listeners.add(onClose);
      signal?.addEventListener('abort', abort, { once: true });
      this.call('turn/start', { threadId, input: [{ type: 'text', text: input }],
        model, effort: 'low', outputSchema }, signal).then(({ turn }) => {
        turnId = turn.id;
        for (const message of beforeAcknowledgement) {
          if (!this.listeners.has(receive)) break;
          receive(message);
        }
      }).catch(error => {
        this.close(error);
        fail(error);
      });
    });
  }

  close(error = codexFailure('')) {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.pending.values()]) handler.reject(error);
    for (const listener of [...this.listeners]) listener({ method: 'local/closed', error });
    this.listeners.clear();
    this.lines?.close();
    this.child.kill();
  }
}
