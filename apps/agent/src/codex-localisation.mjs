import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexRpc } from './codex-rpc.mjs';
import { codexExecutable } from './codex-executable.mjs';
import { CodexReviewAccount } from './codex-review-account.mjs';
import { reviewRateLimits } from './codex-review-usage.mjs';
import { ProofreadingProvider } from './proofreading-provider.mjs';
import {
  AI_AUTO_INTERVAL_MS,
  AI_OUTPUT_SCHEMA,
  LOCALISATION_AI_MODEL,
  PROOFREADING_MODELS,
  aiRequest,
  aiSuggestions,
} from '../../../packages/shared/src/ai-localisation.mts';

const MAX_CACHED_SENTENCES = 1024;
const CONTEXT_TARGET_TOKENS = 24_000;
const CODEX_IDLE_MS = 120_000;

const config = {
  model_provider: 'openai',
  notify: [],
  developer_instructions: '',
  model_reasoning_effort: 'low',
  project_doc_max_bytes: 0,
  'skills.include_instructions': false,
  'features.shell_tool': false,
  'features.shell_snapshot': false,
  'features.plugins': false,
  'features.apps': false,
  'features.hooks': false,
  'features.multi_agent': false,
  'features.view_image': false,
  'features.code_mode_host': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'features.image_generation': false,
  'features.sleep_tool': false,
  'features.workspace_dependencies': false,
  'features.skip_host_skill_discovery': true,
  personality: 'none',
  web_search: 'disabled',
};

export class CodexLocalisationAssistant {
  active = null;
  worker = null;
  starting = null;
  idleTimer = null;
  idleDeadline = null;
  closed = false;
  threadConfig = config;
  instructions = '';
  lastGeneration = -Infinity;
  automaticResults = new Map();
  conversation = null;
  lastRateLimits = null;
  signedIn = false;

  /** @param {{profileDirectory?: string, openBrowser?: (url: string) => Promise<void>, providerFetch?: typeof fetch}} [options] */
  constructor({ profileDirectory, openBrowser, providerFetch } = {}) {
    this.profileDirectory = profileDirectory;
    this.account = new CodexReviewAccount({ openBrowser, changed: () => this.scheduleIdleStop() });
    this.providers = {
      deepseek: new ProofreadingProvider('deepseek', providerFetch),
      kimi: new ProofreadingProvider('kimi', providerFetch),
    };
  }

  async startWorker(passive = false) {
    if (this.closed) throw new Error('Запрос ИИ отменён.');
    if (!passive) this.clearIdleStop();
    if (this.worker && !this.worker.closed && !this.starting) return this.worker;
    if (this.starting) return this.starting;
    this.starting = this.initialiseWorker().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async initialiseWorker() {
    const executable = codexExecutable();
    if (this.profileDirectory) await fs.mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-codex-localisation-'));
    const worker = new CodexRpc({
      cwd: directory,
      executable,
      profileDirectory: this.profileDirectory,
      config: this.profileDirectory ? { ...config, cli_auth_credentials_store: 'file' } : config,
    });
    this.worker = worker;
    // Reap only this process's directory after Codex releases its Windows cwd.
    void worker.exited.then(async () => {
      if (
        path.dirname(directory) === path.resolve(os.tmpdir()) &&
        path.basename(directory).startsWith('eaw-codex-localisation-')
      ) {
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      }
    });
    try {
      if (this.closed) throw new Error('Запрос ИИ отменён.');
      await worker.initialise();
      const settings = await worker.call('config/read', { includeLayers: false });
      const servers = Object.keys(settings.config?.mcp_servers ?? {});
      this.threadConfig = {
        ...config,
        mcp_servers: Object.fromEntries(servers.map((name) => [name, { enabled: false }])),
      };
      this.instructions = await fs.readFile(new URL('./ai-localisation-instructions.txt', import.meta.url), 'utf8');
      return worker;
    } catch (error) {
      worker.close(error);
      throw error;
    }
  }

  clearIdleStop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleDeadline = null;
  }

  scheduleIdleStop() {
    if (this.closed || this.active || this.account.busy || this.account.pending) return;
    if (this.idleTimer || !this.worker || this.worker.closed) return;
    this.idleDeadline = Date.now() + CODEX_IDLE_MS;
    this.idleTimer = setTimeout(() => {
      this.clearIdleStop();
      this.conversation = null;
      this.worker?.close();
    }, CODEX_IDLE_MS);
    this.idleTimer.unref();
  }

  contextStatus() {
    const conversation = this.conversation?.worker === this.worker && !this.worker?.closed ? this.conversation : null;
    return {
      usedTokens: conversation?.tokens ?? 0,
      rolloverTokens: conversation?.limit ?? CONTEXT_TARGET_TOKENS,
      modelWindowTokens: conversation?.contextWindow ?? null,
      idleResetAt: conversation ? this.idleDeadline : null,
      active: Boolean(conversation),
      estimated: Boolean(conversation?.estimated),
    };
  }

  async status(signal, passive = true) {
    try {
      const worker = await this.startWorker(passive);
      const status = await this.account.read(worker, signal);
      this.signedIn = status.signedIn;
      if (!this.signedIn) this.lastRateLimits = null;
      return status;
    } finally {
      this.scheduleIdleStop();
    }
  }

  async usage(signal) {
    const worker = this.worker;
    let live = Boolean(worker && !worker.closed && !this.starting);
    try {
      if (live && this.signedIn && !this.account.busy && !this.account.pending) {
        const raw = await worker.call('account/rateLimits/read', undefined, signal, 5000);
        if (this.worker === worker && !worker.closed && this.signedIn && !this.account.busy && !this.account.pending) {
          this.lastRateLimits = reviewRateLimits(raw);
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    } finally {
      this.scheduleIdleStop();
    }
    live = Boolean(this.worker && !this.worker.closed && !this.starting);
    return { context: this.contextStatus(), rateLimits: this.lastRateLimits, signedIn: this.signedIn, live };
  }

  async changeAccount(action) {
    if (!this.profileDirectory) throw new Error('Отдельный профиль Codex для Review недоступен.');
    if (this.active || this.account.busy) throw new Error('Дождитесь завершения текущего запроса ИИ.');
    this.account.busy = true;
    try {
      const worker = await this.startWorker();
      if (action === 'login' || action === 'cancel-login') {
        const status = action === 'login' ? await this.account.login(worker) : await this.account.cancel(worker);
        this.signedIn = status.signedIn;
        if (!status.signedIn) this.lastRateLimits = null;
        return status;
      }
      if (this.account.pending) await this.account.cancel(worker);
      return await this.account.logout(worker);
    } finally {
      if (action === 'logout') {
        this.signedIn = false;
        this.lastRateLimits = null;
        this.clearCachedResults('codex');
        this.conversation = null;
        this.lastGeneration = -Infinity;
        this.worker?.close();
      }
      this.account.busy = false;
      this.scheduleIdleStop();
    }
  }

  clearCachedResults(provider) {
    for (const key of this.automaticResults.keys()) {
      if (key.startsWith(`${provider}\0`)) this.automaticResults.delete(key);
    }
  }

  async setProviderKey(provider, key, signal) {
    if (this.closed) throw new Error('Запрос ИИ отменён.');
    if (this.active) throw new Error('Дождитесь завершения текущего запроса ИИ.');
    const controller = new AbortController();
    this.active = controller;
    try {
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const status = await this.providers[provider].setKey(key, combined);
      this.clearCachedResults(provider);
      return status;
    } finally {
      this.active = null;
      this.scheduleIdleStop();
    }
  }

  async generateCodex(input, signal) {
    const status = await this.status(signal, false);
    if (!status.signedIn) throw new Error('Войдите в Codex в окне «Орфография и грамматика (тест)».');
    const worker = this.worker;
    try {
      if (signal.aborted) throw new Error('Запрос ИИ отменён.');
      let conversation = this.conversation;
      if (conversation?.worker !== worker || conversation.tokens + Math.ceil(input.length / 2) >= conversation.limit) {
        await this.releaseConversation();
        const { thread } = await worker.call(
          'thread/start',
          {
            model: LOCALISATION_AI_MODEL,
            modelProvider: 'openai',
            cwd: worker.cwd,
            ephemeral: true,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            baseInstructions: this.instructions,
            developerInstructions: '',
            config: this.threadConfig,
          },
          signal,
        );
        this.conversation = conversation = { worker, id: thread.id, tokens: 0, limit: CONTEXT_TARGET_TOKENS };
      }
      this.lastGeneration = performance.now();
      const result = await worker.generate(conversation.id, input, AI_OUTPUT_SCHEMA, LOCALISATION_AI_MODEL, signal);
      conversation.tokens =
        result.usage?.inputTokens !== undefined
          ? result.usage.inputTokens + (result.usage.outputTokens ?? 0)
          : conversation.tokens + Math.ceil((input.length + result.text.length) / 2);
      conversation.estimated = result.usage?.inputTokens === undefined;
      if (result.contextWindow > 0) {
        conversation.contextWindow = result.contextWindow;
        conversation.limit = Math.min(CONTEXT_TARGET_TOKENS, Math.floor(result.contextWindow * 0.8));
      }
      return result;
    } catch (error) {
      if (signal.aborted) worker.close(new Error('Запрос ИИ отменён.'));
      throw error;
    }
  }

  async run(value, signal, provider = 'codex') {
    const request = aiRequest(value);
    if (this.closed) throw new Error('Запрос ИИ отменён.');
    const external = this.providers[provider];
    if (!external && (this.account.busy || this.account.pending))
      throw new Error('Дождитесь завершения входа в Codex.');
    const started = Date.now();
    const suggestionsByText = new Map();
    const toCheck = new Map();
    const cacheKey = (text) => `${provider}\0${request.language}\0${text}`;
    if (request.automatic) {
      for (const entry of request.entries) {
        const key = cacheKey(entry.text);
        if (this.automaticResults.has(key)) {
          const cached = this.automaticResults.get(key);
          this.automaticResults.delete(key);
          this.automaticResults.set(key, cached);
          suggestionsByText.set(entry.text, cached);
        } else if (!toCheck.has(entry.text)) toCheck.set(entry.text, entry);
      }
    }
    const output = (suggestions, usage) => ({
      model: PROOFREADING_MODELS[provider].id,
      suggestions,
      durationMs: usage ? Date.now() - started : 0,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        ...(usage?.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
      },
    });
    const automaticSuggestions = () =>
      request.entries.flatMap(({ key, text }) => {
        const suggestion = suggestionsByText.get(text);
        return suggestion ? [{ ...suggestion, key }] : [];
      });
    if (request.automatic) {
      if (!toCheck.size) return output(automaticSuggestions());
      const retryAfterMs = this.active
        ? AI_AUTO_INTERVAL_MS
        : Math.ceil(this.lastGeneration + AI_AUTO_INTERVAL_MS - performance.now());
      if (retryAfterMs > 0) return { retryAfterMs };
    }
    if (this.active) throw new Error('Дождитесь завершения текущего запроса ИИ.');
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const entries = request.automatic ? [...toCheck.values()] : request.entries;
      const prompt = { mode: request.mode, language: request.language, entries };
      const input = JSON.stringify(prompt);
      let result;
      if (external) {
        this.lastGeneration = performance.now();
        result = await external.generate(input, controller.signal);
      } else {
        result = await this.generateCodex(input, controller.signal);
      }
      const suggestions = aiSuggestions(JSON.parse(result.text), prompt);
      if (!request.automatic) return output(suggestions, result.usage);
      const byKey = new Map(suggestions.map((suggestion) => [suggestion.key, suggestion]));
      for (const { key, text } of entries) {
        const suggestion = byKey.get(key) ?? null;
        const correction = suggestion && { text: suggestion.text, reason: suggestion.reason };
        suggestionsByText.set(text, correction);
        if (this.automaticResults.size >= MAX_CACHED_SENTENCES) {
          this.automaticResults.delete(this.automaticResults.keys().next().value);
        }
        this.automaticResults.set(cacheKey(text), correction);
      }
      return output(automaticSuggestions(), result.usage);
    } catch (error) {
      if (!external) await this.releaseConversation();
      if (error instanceof SyntaxError)
        throw new Error(
          external ? 'Провайдер ИИ вернул некорректный ответ.' : 'Codex вернул некорректный ответ. Повторите запрос.',
        );
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.active = null;
      this.scheduleIdleStop();
    }
  }

  async releaseConversation() {
    const conversation = this.conversation;
    this.conversation = null;
    if (conversation && !conversation.worker.closed) {
      await conversation.worker
        .call('thread/unsubscribe', { threadId: conversation.id }, undefined, 1000)
        .catch(() => {});
    }
  }

  close() {
    this.closed = true;
    this.clearIdleStop();
    this.active?.abort();
    this.worker?.close(new Error('Запрос ИИ отменён.'));
  }
}
