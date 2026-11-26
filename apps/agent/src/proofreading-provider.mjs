import fs from 'node:fs/promises';
import { PROOFREADING_MODELS } from '../../../packages/shared/src/ai-localisation.mts';

const providers = {
  deepseek: { url: 'https://api.deepseek.com/', reasoningEffort: 'none' },
  kimi: { url: 'https://api.moonshot.ai/v1/', reasoningEffort: 'low' },
};

const MAX_RESPONSE_BYTES = 512 * 1024;

async function responseJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('Ответ провайдера ИИ слишком большой.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class ProofreadingProvider {
  #apiKey = '';

  constructor(name, fetchResponse = fetch) {
    this.name = name;
    this.settings = providers[name];
    this.model = PROOFREADING_MODELS[name].id;
    this.fetchResponse = fetchResponse;
  }

  status() {
    return { signedIn: Boolean(this.#apiKey) };
  }

  async request(route, apiKey, signal, body) {
    const timeout = AbortSignal.timeout(body ? 60_000 : 10_000);
    try {
      const response = await this.fetchResponse(new URL(route, this.settings.url), {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        ...(body && { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status };
      }
      return { status: response.status, data: await responseJson(response) };
    } catch (error) {
      if (signal?.aborted) throw new Error('Запрос ИИ отменён.');
      if (timeout.aborted) throw new Error('Провайдер ИИ не ответил вовремя.');
      if (error instanceof SyntaxError) throw new Error('Провайдер ИИ вернул некорректный ответ.');
      if (error instanceof TypeError) throw new Error('Не удалось подключиться к провайдеру ИИ.');
      throw error;
    }
  }

  checkStatus(status) {
    if (status === 401 || status === 403)
      throw new Error('Провайдер ИИ отклонил API-ключ. Проверьте ключ и права доступа.');
    if (status === 402) throw new Error('Провайдер ИИ требует пополнить баланс API.');
    if (status === 429) throw new Error('Достигнут лимит API провайдера. Повторите запрос позже.');
    if (status < 200 || status >= 300) throw new Error(`Провайдер ИИ вернул ошибку HTTP ${status}.`);
  }

  async setKey(value, signal) {
    if (value === null) {
      this.#apiKey = '';
      return this.status();
    }
    const apiKey = typeof value === 'string' ? value.trim() : '';
    if (!/^[!-~]{1,512}$/u.test(apiKey)) throw new Error('Введите действительный API-ключ.');
    const { status, data } = await this.request('models', apiKey, signal);
    this.checkStatus(status);
    if (!Array.isArray(data?.data) || !data.data.some((model) => model?.id === this.model)) {
      throw new Error('Выбранная модель недоступна для этого API-ключа.');
    }
    signal?.throwIfAborted();
    this.#apiKey = apiKey;
    return this.status();
  }

  async generate(input, signal) {
    if (!this.#apiKey) throw new Error('Добавьте API-ключ выбранного провайдера в окне проверки.');
    const instructions = await fs.readFile(new URL('./ai-localisation-instructions.txt', import.meta.url), 'utf8');
    const { status, data } = await this.request('chat/completions', this.#apiKey, signal, {
      model: this.model,
      reasoning_effort: this.settings.reasoningEffort,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            instructions +
            '\nReturn this JSON object: {"suggestions":[{"key":"K","text":"Corrected value","reason":"Short explanation"}]}.' +
            ' If no correction is needed, return {"suggestions":[]}.',
        },
        { role: 'user', content: input },
      ],
    });
    this.checkStatus(status);
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('Ответ модели обрезан. Выберите меньший фрагмент.');
    if (
      choice?.finish_reason !== 'stop' ||
      typeof choice.message?.content !== 'string' ||
      !choice.message.content.trim()
    ) {
      throw new Error('Провайдер ИИ вернул некорректный ответ.');
    }
    return {
      text: choice.message.content,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.prompt_cache_hit_tokens,
      },
    };
  }
}
