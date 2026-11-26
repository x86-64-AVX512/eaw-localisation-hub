import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AI_AUTO_INTERVAL_MS,
  aiRequest,
  aiSentenceAt,
  aiSuggestions,
  aiCorrectionRange,
  LOCALISATION_AI_MODEL,
} from '../packages/shared/src/ai-localisation.mts';
import { scanLocalisationEntries } from '../packages/shared/src/localisation-replace.mts';
import { startReviewServer } from '../apps/agent/src/review-server.mjs';
import { CodexLocalisationAssistant } from '../apps/agent/src/codex-localisation.mjs';
import { reviewRateLimits } from '../apps/agent/src/codex-review-usage.mjs';
import { updateProofreadingQueue } from '../apps/review/src/ai-proofreading-queue.ts';

test('AI accepts bounded, unique proofreading values and rejects the removed mode', () => {
  assert.equal(LOCALISATION_AI_MODEL, 'gpt-6-luna');
  assert.throws(() =>
    aiRequest({ mode: 'review', entries: Array.from({ length: 9 }, (_, i) => ({ key: `K${i}`, text: '' })) }),
  );
  assert.throws(() =>
    aiRequest({
      mode: 'review',
      entries: [
        { key: 'K', text: '' },
        { key: 'K', text: '' },
      ],
    }),
  );
  assert.throws(() => aiRequest({ mode: 'review', entries: [{ key: 'K', text: 'a'.repeat(12_001) }] }));
  assert.throws(() => aiRequest({ mode: 'complete', entries: [{ key: 'K', text: 'Текст' }] }), /только проверка/u);
});

test('AI corrections preserve technical expressions, colour order and escape sequences', () => {
  const text = '§Y$COUNTRY$§! [Root.GetName] £army_experience \\n Граф решили.';
  const request = aiRequest({ mode: 'review', entries: [{ key: 'K', text }] });
  const corrected = text.replace('решили', 'решил');
  assert.deepEqual(aiSuggestions({ suggestions: [{ key: 'K', text: corrected, reason: 'Согласование.' }] }, request), [
    { key: 'K', text: corrected, reason: 'Согласование.' },
  ]);
  for (const unsafe of [
    corrected.replace('$COUNTRY$', ''),
    corrected.replace('Root.GetName', 'Root.GetLeader'),
    corrected.replace('§Y', '§R'),
    corrected.replace('\\n', ''),
    corrected.replace('£army_experience', ''),
  ]) {
    assert.throws(
      () => aiSuggestions({ suggestions: [{ key: 'K', text: unsafe, reason: '' }] }, request),
      /технические/u,
    );
  }
});

test('automatic proofreading captures a whole sentence without adjacent text or markup boundaries', () => {
  const first = '🦄 §YПервое§! предложение.';
  const second = 'Граф [Root.GetName] решили устроить охоту.';
  const text = `${first}  ${second}\\NПока ещё пишу`;
  const start = text.indexOf(second);
  const edit = text.indexOf('решили');
  assert.deepEqual(aiSentenceAt(text, edit, edit + 6), { start, text: second });
  assert.deepEqual(aiSentenceAt(text, 5, 8), { start: 0, text: first });
  assert.deepEqual(aiSentenceAt(text, first.length, first.length + 1), { start: 0, text: first });
  assert.deepEqual(aiSentenceAt(text, text.length, text.length), {
    start: text.indexOf('Пока'),
    text: 'Пока ещё пишу',
  });
  const quoted = 'Она сказала: \\"Готово!\\"';
  assert.deepEqual(aiSentenceAt(quoted, 16, 20), { start: 0, text: quoted });
  for (const invalid of [text, '$КЛЮЧ$.', 'Раз. Два.']) {
    assert.throws(
      () => aiRequest({ mode: 'review', automatic: true, entries: [{ key: 'K', text: invalid }] }),
      /один фрагмент/u,
    );
  }
});

test('English proofreading recognises English sentences and skips standalone game markup', () => {
  const title = 'An invitation from [Root.GetName]';
  const text = `${title}\\nHe saw a apple. He went home.`;
  const edit = text.indexOf('apple');
  assert.deepEqual(aiSentenceAt(text, 0, title.length, 'english'), { start: 0, text: title });
  assert.deepEqual(aiSentenceAt(text, edit, edit + 5, 'english'), {
    start: text.indexOf('He saw'),
    text: 'He saw a apple.',
  });
  const entry = { key: 'K', text: title };
  assert.equal(
    aiRequest({ mode: 'review', language: 'english', automatic: true, entries: [entry] }).language,
    'english',
  );
  assert.throws(() => aiRequest({ mode: 'review', automatic: true, entries: [entry] }), /один фрагмент/u);
  assert.throws(() => aiRequest({ mode: 'review', language: 'german', entries: [entry] }), /английской/u);
  for (const markup of ['[Root.GetName]', '$COUNTRY$', '§Y£army_experience§!']) {
    assert.equal(aiSentenceAt(markup, 0, markup.length, 'english'), null);
  }
});

test('proofreading accepts a title ending at the closing quote and skips unclosed values', () => {
  const line = ' BAR_kind_letter:0 "Любезный письмо';
  for (const unclosed of [line, line + '\\"', line + '»']) {
    assert.deepEqual(scanLocalisationEntries(unclosed).entries, []);
  }
  const [entry] = scanLocalisationEntries(line + '" # Комментарий').entries;
  const sentence = aiSentenceAt(entry.text, entry.text.length, entry.text.length);
  assert.deepEqual(sentence, { start: 0, text: 'Любезный письмо' });
  const request = aiRequest({ mode: 'review', automatic: true, entries: [{ key: entry.key, text: sentence.text }] });
  assert.equal(request.entries[0].text, 'Любезный письмо');
});

test('proofreading queues all edited sentences and remaps earlier edits across line insertions', () => {
  const first = 'A:0 "Любезный письмо. Граф решили."';
  const second = 'B:0 "Две лошадь"';
  let text = `${first}\n${second}`;
  const model = {
    getPositionAt(offset) {
      const lines = text.slice(0, offset).split('\n');
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
    },
    getLineContent: (line) => text.split('\n')[line - 1],
    getOffsetAt: ({ lineNumber, column }) =>
      text
        .split('\n')
        .slice(0, lineNumber - 1)
        .reduce((offset, line) => offset + line.length + 1, column - 1),
  };
  const queue = updateProofreadingQueue(model, [], [{ rangeOffset: 0, rangeLength: 0, text }], true, 'russian');
  assert.deepEqual(
    queue.map((item) => item.text),
    ['Любезный письмо.', 'Граф решили.', 'Две лошадь'],
  );
  text = '\n' + text.replace('лошадь', 'лошад');
  const next = updateProofreadingQueue(
    model,
    queue,
    [
      { rangeOffset: first.length + 1 + second.indexOf('ь'), rangeLength: 1, text: '' },
      { rangeOffset: 0, rangeLength: 0, text: '\n' },
    ],
    true,
    'russian',
  );
  assert.deepEqual(
    next.map((item) => [item.line, item.text]),
    [
      [2, 'Любезный письмо.'],
      [2, 'Граф решили.'],
      [3, 'Две лошад'],
    ],
  );
  assert.equal(next[0], queue[0]);
  assert.notEqual(next[2], queue[2]);
});

test('Agent spaces automatic generations and reuses checked sentences after other checks', async () => {
  const assistant = new CodexLocalisationAssistant();
  const prompts = [];
  const calls = [];
  const threads = [];
  let finish;
  let started;
  const generating = new Promise((resolve) => {
    started = resolve;
  });
  assistant.worker = {
    call: async (method) => {
      calls.push(method);
      return { thread: { id: `thread-${calls.length}` } };
    },
    generate: async (thread, input) => {
      threads.push(thread);
      const prompt = JSON.parse(input);
      prompts.push(prompt);
      started();
      await new Promise((resolve) => {
        finish = resolve;
      });
      const suggestions = prompt.entries
        .filter(({ text }) => text.includes('решили'))
        .map(({ key, text }) => ({ key, text: text.replace('решили', 'решил'), reason: 'Согласование.' }));
      return { text: JSON.stringify({ suggestions }), usage: { inputTokens: 100, outputTokens: 5 } };
    },
    close() {},
  };
  assistant.status = async () => ({ signedIn: true });
  try {
    const request = { mode: 'review', automatic: true, entries: [{ key: 'K', text: 'Первое предложение.' }] };
    const next = {
      ...request,
      entries: [
        { key: 'A', text: 'Первое предложение.' },
        { key: 'B', text: 'Граф решили устроить охоту.' },
        { key: 'C', text: 'Новое предложение.' },
        { key: 'D', text: 'Граф решили устроить охоту.' },
      ],
    };
    const first = assistant.run(request);
    await generating;
    assert.deepEqual(await assistant.run(next), { retryAfterMs: AI_AUTO_INTERVAL_MS });
    finish();
    const output = await first;
    const cached = { ...output, durationMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
    assert.deepEqual(await assistant.run(request), cached);
    const delayed = await assistant.run(next);
    assert.ok(delayed.retryAfterMs > 0 && delayed.retryAfterMs <= AI_AUTO_INTERVAL_MS);
    assert.deepEqual(prompts, [{ mode: 'review', language: 'russian', entries: request.entries }]);
    assistant.lastGeneration = performance.now() - AI_AUTO_INTERVAL_MS;
    const second = assistant.run(next);
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    const secondOutput = await second;
    assert.equal(secondOutput.model, LOCALISATION_AI_MODEL);
    assert.deepEqual(
      secondOutput.suggestions,
      ['B', 'D'].map((key) => ({ key, text: 'Граф решил устроить охоту.', reason: 'Согласование.' })),
    );
    assert.deepEqual(await assistant.run(request), cached);
    assert.deepEqual((await assistant.run(next)).suggestions, secondOutput.suggestions);
    assert.equal(prompts.length, 2);
    assert.deepEqual(
      prompts[1].entries.map((entry) => entry.key),
      ['B', 'C'],
    );
    assert.equal(threads[0], threads[1]);
    assistant.conversation.tokens = assistant.conversation.limit;
    assistant.lastGeneration = performance.now() - AI_AUTO_INTERVAL_MS;
    const third = assistant.run({ ...request, entries: [{ key: 'N', text: 'Другой фрагмент.' }] });
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await third;
    assert.notEqual(threads[1], threads[2]);
    assert.deepEqual(calls, ['thread/start', 'thread/unsubscribe', 'thread/start']);
  } finally {
    assistant.close();
  }
});

test('DeepSeek and Kimi validate their own keys, batch proofreading and keep separate caches', async (t) => {
  const calls = [];
  const assistant = new CodexLocalisationAssistant({
    providerFetch: async (origin, init) => {
      calls.push({ url: origin.href, init });
      const deepseek = origin.hostname === 'api.deepseek.com';
      const model = deepseek ? 'deepseek-flash' : 'kimi-k3.1-pro';
      if (init.headers.Authorization !== `Bearer ${deepseek ? 'deepseek-key' : 'kimi-key'}`) {
        return new Response('provider diagnostic body', { status: 401 });
      }
      if (init.method === 'GET') return Response.json({ data: [{ id: model }] });
      const body = JSON.parse(init.body);
      assert.equal(body.model, model);
      assert.equal(body.reasoning_effort, deepseek ? 'none' : 'low');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.equal(init.redirect, 'error');
      assert.match(body.messages[0].content, /spelling and grammar/u);
      assert.equal(body.messages.length, 2);
      const { entries } = JSON.parse(body.messages[1].content);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                suggestions: [
                  {
                    key: entries[0].key,
                    text: 'Граф решил.',
                    reason: deepseek ? 'Согласование.' : 'Число глагола.',
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      });
    },
  });
  t.after(() => assistant.close());
  assistant.status = async () => assert.fail('External providers must not start Codex');
  const request = {
    mode: 'review',
    automatic: true,
    entries: [
      { key: 'A', text: 'Граф решили.' },
      { key: 'B', text: 'Яблоко.' },
    ],
  };

  assert.deepEqual(assistant.providers.deepseek.status(), { signedIn: false });
  await assert.rejects(assistant.setProviderKey('deepseek', 'invalid-key'), /проверьте ключ/iu);
  assert.deepEqual(assistant.providers.deepseek.status(), { signedIn: false });
  assert.deepEqual(await assistant.setProviderKey('deepseek', 'deepseek-key'), { signedIn: true });
  assert.deepEqual(await assistant.setProviderKey('kimi', 'kimi-key'), { signedIn: true });
  const deepseek = await assistant.run(request, undefined, 'deepseek');
  assert.equal(deepseek.model, 'deepseek-flash');
  assert.equal(deepseek.suggestions[0].reason, 'Согласование.');
  assert.equal(deepseek.usage.inputTokens, 50);
  assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).init.body).messages[1].content).entries, request.entries);
  assert.equal(calls.at(-1).url, 'https://api.deepseek.com/chat/completions');
  assert.equal((await assistant.run(request, undefined, 'deepseek')).usage.inputTokens, 0);

  assistant.lastGeneration = -Infinity;
  const kimi = await assistant.run(request, undefined, 'kimi');
  assert.equal(kimi.model, 'kimi-k3.1-pro');
  assert.equal(kimi.suggestions[0].reason, 'Число глагола.');
  assert.equal(calls.at(-1).url, 'https://api.moonshot.ai/v1/chat/completions');
  assert.deepEqual(await assistant.setProviderKey('deepseek', null), { signedIn: false });
  assert.equal((await assistant.run(request, undefined, 'kimi')).usage.inputTokens, 0);
  assistant.lastGeneration = -Infinity;
  await assert.rejects(assistant.run(request, undefined, 'deepseek'), /Добавьте API-ключ/u);
  assert.equal(calls.length, 5);
});

test('grammar highlighting marks the incorrect word instead of the entire value', () => {
  assert.deepEqual(aiCorrectionRange('Граф решили устроить охоту.', 'Граф решил устроить охоту.'), {
    start: 5,
    end: 11,
    text: 'решил',
  });
  assert.equal(aiCorrectionRange('Верно.', 'Верно.'), null);
  for (const [before, after] of [
    ['🦄 Граф решили.', '🦄 Граф решил.'],
    ['Пойдём домой', 'Пойдём домой.'],
    ['Он он пришёл.', 'Он пришёл.'],
    ['Неверно', 'Совсем иначе'],
    ['🦄', '🐴'],
  ]) {
    const range = aiCorrectionRange(before, after);
    assert.equal(before.slice(0, range.start) + range.text + before.slice(range.end), after);
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(before.slice(range.start)));
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(before.slice(range.end)));
  }
});

test('AI output cannot introduce keys, duplicate suggestions or physical newlines', () => {
  const request = aiRequest({ mode: 'review', entries: [{ key: 'K', text: 'Текст' }] });
  for (const suggestions of [
    [{ key: 'OTHER', text: 'Текст', reason: '' }],
    [{ key: 'K', text: 'Текст\nХвост', reason: '' }],
    [
      { key: 'K', text: 'Текст', reason: '' },
      { key: 'K', text: 'Текст', reason: '' },
    ],
  ])
    assert.throws(() => aiSuggestions({ suggestions }, request));
  assert.deepEqual(aiSuggestions({ suggestions: [] }, request), []);
  assert.deepEqual(aiSuggestions({ suggestions: [{ key: 'K', text: 'Текст', reason: '' }] }, request), []);
});

test('AI endpoints require a local capability and same-origin requests before touching Codex', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-ai-api-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const hub = {
    options: { repo },
    englishOriginal() {
      throw new Error('Invalid input reached English lookup');
    },
  };
  const review = await startReviewServer(hub, { repo, state: path.join(root, 'state'), workspace: 'test' });
  t.after(async () => {
    await review.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { origin, token } = JSON.parse(await fs.readFile(review.discoveryPath, 'utf8'));
  const url = origin + '/api/ai-localisation/';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url + 'status')).status, 403);
  assert.equal((await fetch(url + 'usage')).status, 403);
  assert.equal(
    (await fetch(url + 'status', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.invalid' } }))
      .status,
    403,
  );
  for (const route of ['login', 'cancel-login', 'logout', 'api-key?provider=deepseek']) {
    assert.equal((await fetch(url + route, { method: 'POST' })).status, 403);
    assert.equal(
      (
        await fetch(url + route, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: 'https://example.invalid',
          },
        })
      ).status,
      403,
    );
  }
  const externalStatus = await fetch(url + 'status?provider=deepseek', { headers });
  assert.equal(externalStatus.status, 200);
  assert.deepEqual(await externalStatus.json(), { signedIn: false });
  assert.equal((await fetch(url + 'status?provider=toString', { headers })).status, 409);
  const blankKey = await fetch(url + 'api-key?provider=kimi', {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: ' ' }),
  });
  assert.equal(blankKey.status, 409);
  assert.match((await blankKey.json()).error, /Введите действительный API-ключ/u);
  const bad = await fetch(url + 'run', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'review', entries: [] }),
  });
  assert.equal(bad.status, 409);
  assert.match((await bad.json()).error, /от 1 до 8/u);
  const removed = await fetch(url + 'run', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'complete', entries: [{ key: 'K', text: 'Граф решил ' }] }),
  });
  assert.equal(removed.status, 409);
  assert.match((await removed.json()).error, /только проверка/u);
});
test('Review tracks the isolated Codex sign-in and clears local proofreading state on logout', async () => {
  const opened = [];
  const calls = [];
  const assistant = new CodexLocalisationAssistant({
    profileDirectory: 'review-codex',
    openBrowser: async (url) => {
      opened.push(url);
    },
  });
  let account = null;
  let sequence = 0;
  const worker = {
    closed: false,
    listeners: new Set(),
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'account/read') return { account };
      if (method === 'account/login/start') {
        return { type: 'chatgpt', loginId: `login-${++sequence}`, authUrl: 'https://auth.openai.com/oauth/authorize' };
      }
      if (method === 'account/logout') account = null;
      return {};
    },
    close() {
      this.closed = true;
    },
  };
  assistant.worker = worker;
  const complete = (loginId, success) => {
    for (const listener of worker.listeners)
      listener({ method: 'account/login/completed', params: { loginId, success } });
  };
  try {
    assert.equal((await assistant.status()).signedIn, false);
    assert.equal((await assistant.changeAccount('login')).loginPending, true);
    assert.equal(assistant.idleTimer?.hasRef() ?? false, false);
    complete('old-login', true);
    assert.equal((await assistant.status()).loginPending, true);
    assert.equal((await assistant.changeAccount('cancel-login')).loginPending, false);
    assert.ok(calls.some(([method, params]) => method === 'account/login/cancel' && params.loginId === 'login-1'));
    assert.equal((await assistant.changeAccount('login')).loginPending, true);
    assert.equal(opened.length, 2);
    account = { type: 'chatgpt', email: 'review@example.invalid' };
    complete('login-2', true);
    const status = await assistant.status();
    assert.equal(status.loginPending, false);
    assert.equal(status.email, 'review@example.invalid');
    assistant.automaticResults.set('codex\0russian\0cached result', {});
    assistant.conversation = { worker, id: 'old-thread' };
    assert.equal((await assistant.changeAccount('logout')).signedIn, false);
    assert.equal(assistant.automaticResults.size, 0);
    assert.equal(assistant.conversation, null);
    assert.equal(worker.closed, true);
  } finally {
    assistant.close();
  }
});

test('Review usage shows Codex windows and preserves the idle rollover deadline', async () => {
  const raw = {
    rateLimits: {
      limitId: 'codex',
      planType: 'plus',
      primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: null },
    },
  };
  const limits = {
    plan: 'plus',
    limits: [
      { name: '', remainingPercent: 72, durationMinutes: 300, resetsAt: 1_800_000_000_000 },
      { name: '', remainingPercent: 84, durationMinutes: 10_080, resetsAt: null },
    ],
  };
  assert.deepEqual(reviewRateLimits(raw), limits);
  assert.deepEqual(reviewRateLimits({ rateLimitsByLimitId: { codex: raw.rateLimits } }), limits);
  assert.deepEqual(reviewRateLimits({}), { plan: null, limits: [] });

  const assistant = new CodexLocalisationAssistant();
  assistant.startWorker = () => {
    throw new Error('Passive usage must not start Codex');
  };
  const empty = await assistant.usage();
  assert.equal(empty.live, false);
  assert.equal(empty.signedIn, false);
  assert.equal(empty.rateLimits, null);
  let reads = 0;
  const worker = {
    closed: false,
    close() {
      this.closed = true;
    },
    async call(method) {
      assert.equal(method, 'account/rateLimits/read');
      reads++;
      return raw;
    },
  };
  assistant.worker = worker;
  assistant.signedIn = true;
  assistant.conversation = { worker, id: 'thread', tokens: 6_300, limit: 24_000, contextWindow: 100_000 };
  assistant.scheduleIdleStop();
  try {
    const deadline = assistant.idleDeadline;
    const timer = assistant.idleTimer;
    assert.deepEqual(await assistant.usage(), {
      rateLimits: limits,
      signedIn: true,
      live: true,
      context: {
        active: true,
        estimated: false,
        usedTokens: 6_300,
        rolloverTokens: 24_000,
        modelWindowTokens: 100_000,
        idleResetAt: deadline,
      },
    });
    assert.equal(assistant.idleTimer, timer);
    worker.close();
    const idle = await assistant.usage();
    assert.equal(idle.live, false);
    assert.deepEqual(idle.rateLimits, limits);
    assert.equal(reads, 1);
    assert.equal(assistant.contextStatus().active, false);
    assert.equal(assistant.contextStatus().idleResetAt, null);
  } finally {
    assistant.close();
  }
});
