import type * as Monaco from 'monaco-editor';
import { AI_AUTO_INTERVAL_MS, LOCALISATION_AI_MODEL, MAX_AI_AUTOMATIC_ENTRIES, MAX_AI_REQUEST_CHARS, aiRequest, aiSuggestions, aiCorrectionRange } from '../../../packages/shared/src/ai-localisation.mts';
import type { AiRequest, AiSuggestion, ProofreadingLanguage } from '../../../packages/shared/src/ai-localisation.mts';
import { scanLocalisationEntries } from '../../../packages/shared/src/localisation-replace.mts';
import { uiText, uiMessage } from '../../../packages/shared/src/ui-language.mts';
import { requiredElement } from './dom-elements.ts';
import type { createAppState } from './app-state.ts';
import { isWorkspaceVisible } from './workspace-runtime.ts';
import { proofreadingCandidates, updateProofreadingQueue } from './ai-proofreading-queue.ts';
import type { ProofreadingCandidate } from './ai-proofreading-queue.ts';
import { createAiUsagePanel } from './ai-usage-panel.ts';
import type { CodexUsage } from './ai-usage-panel.ts';

const AUTO_CHECK_KEY = 'eaw-ai-automatic-proofreading';
function proofreadingLanguage(path: string): ProofreadingLanguage | null {
  const language = /^localisation\/(?:replace\/)?(russian|english)\//u.exec(path)?.[1];
  return language === 'russian' || language === 'english' ? language : null;
}

interface Location { key: string; text: string; line: number; startColumn: number }
interface Snapshot {
  model: Monaco.editor.ITextModel;
  version: number;
  path: string;
  ticket: string;
  request: AiRequest;
  locations: Location[];
}
interface AiResult {
  model: string;
  suggestions: AiSuggestion[];
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}
interface CodexAccountStatus {
  signedIn: boolean;
  email?: string;
  loginPending?: boolean;
  loginFailed?: boolean;
}
interface Issue {
  id: string;
  location: Location;
  range: Monaco.Range;
  replacement: string;
  reason: string;
  button: HTMLButtonElement;
}

export function createAiLocalisationPanel({ monaco, editor, state, token, showToast }: {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
  state: ReturnType<typeof createAppState>;
  token: string;
  showToast: (message: string, error?: boolean) => void;
}) {
  const dialog = requiredElement<HTMLDialogElement>('#ai-localisation-dialog');
  const status = requiredElement<HTMLElement>('#ai-localisation-status');
  const results = requiredElement<HTMLElement>('#ai-localisation-results');
  const check = requiredElement<HTMLButtonElement>('#ai-localisation-check');
  const accountStatus = requiredElement<HTMLElement>('#ai-localisation-account');
  const usagePanel = createAiUsagePanel();
  const loginButton = requiredElement<HTMLButtonElement>('#ai-localisation-login');
  const logoutButton = requiredElement<HTMLButtonElement>('#ai-localisation-logout');
  const cancelLoginButton = requiredElement<HTMLButtonElement>('#ai-localisation-cancel-login');
  const connectionButton = requiredElement<HTMLButtonElement>('#ai-localisation-connect');
  const automatic = requiredElement<HTMLInputElement>('#ai-localisation-automatic');
  const pendingDecoration = editor.createDecorationsCollection();
  const countdown = document.createElement('div');
  countdown.className = 'ai-localisation-countdown';
  countdown.setAttribute('role', 'timer');
  countdown.title = uiText('До фоновой проверки, секунд');
  countdown.setAttribute('aria-label', countdown.title);
  let countdownRange: Monaco.Range | null = null;
  const countdownWidget: Monaco.editor.IGlyphMarginWidget = {
    getId: () => 'eaw.ai.countdown',
    getDomNode: () => countdown,
    getPosition: () => ({ lane: monaco.editor.GlyphMarginLane.Right, zIndex: 1, range: countdownRange! }),
  };
  let outlined: ProofreadingCandidate[] = [];
  let pending: ProofreadingCandidate[] = [];
  let pendingLanguage: ProofreadingLanguage | null = null;
  let batchSequence = 0;
  let automaticTimer: ReturnType<typeof setTimeout> | undefined;
  let nextCheckAt = 0;
  let automaticController: AbortController | null = null;
  let accountController: AbortController | null = null;
  let accountPoll: ReturnType<typeof setTimeout> | undefined;
  let account: CodexAccountStatus | null = null;
  let usageController: AbortController | null = null;
  let usageTimer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;
  let lastAutomaticError = '';
  let controller: AbortController | null = null;
  let snapshot: Snapshot | null = null;
  let issues: Issue[] = [];
  let generation = 0;
  let applying = false;
  let markedModel: Monaco.editor.ITextModel | null = null;

  function editable(): boolean {
    return state.ready && state.documentView === 'shared' && !state.suggestionProjection
      && !editor.getOption(monaco.editor.EditorOption.readOnly);
  }

  function current(value: Snapshot): boolean {
    return editable() && editor.getModel() === value.model && value.model.getVersionId() === value.version
      && state.path === value.path && (state.ticket?.id ?? '') === value.ticket;
  }

  function visible(location: Location, ranges = editor.getVisibleRanges()): boolean {
    if (!isWorkspaceVisible() || document.hidden) return false;
    const { line: lineNumber, startColumn } = location;
    const endColumn = startColumn + location.text.length;
    if (!ranges.some(range => range.containsRange(new monaco.Range(lineNumber, startColumn, lineNumber, endColumn)))) return false;
    const start = editor.getScrolledVisiblePosition({ lineNumber, column: startColumn });
    const end = editor.getScrolledVisiblePosition({ lineNumber, column: endColumn });
    const { height, contentLeft, contentWidth } = editor.getLayoutInfo();
    return Boolean(start && end && start.top >= 0 && end.top + end.height <= height
      && start.left >= contentLeft && end.left <= contentLeft + contentWidth);
  }

  function capture(): Snapshot {
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!editable() || !model || !selection) {
      throw new Error(uiText('Откройте документ локализации в режиме редактирования.'));
    }
    const language = proofreadingLanguage(state.relativePath);
    if (!language) {
      throw new Error(uiText('Проверка ИИ доступна для русской и английской локализации.'));
    }
    const first = selection.startLineNumber;
    const last = selection.endLineNumber - Number(selection.endColumn === 1 && selection.endLineNumber > first);
    if (last - first > 200) throw new Error(uiText('Для ИИ выберите небольшой фрагмент до 8 ключей.'));
    const locations: Location[] = [];
    const ranges = editor.getVisibleRanges();
    for (let line = first; line <= last; line += 1) {
      if (!ranges.some(range => line >= range.startLineNumber && line <= range.endLineNumber)) continue;
      const scanned = scanLocalisationEntries(model.getLineContent(line));
      if (scanned.ambiguousEntries.length) throw new Error(uiText('Сначала исправьте неоднозначные кавычки.'));
      for (const entry of scanned.entries) {
        const location = { key: entry.key, text: entry.text, line, startColumn: entry.start + 1 };
        if (visible(location, ranges)) locations.push(location);
      }
    }
    if (!locations.length) throw new Error(uiText('Выберите значение, которое целиком видно в редакторе.'));
    const request = aiRequest({ mode: 'review', language, entries: locations.map(({ key, text }) => ({ key, text })) });
    return { model, version: model.getVersionId(), path: state.path, ticket: state.ticket?.id ?? '', request, locations };
  }

  async function request<T>(route: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await fetch(`/api/ai-localisation/${route}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(uiMessage(result.error ?? `HTTP ${response.status}`));
    return result;
  }

  function cancel(): void {
    generation += 1;
    controller?.abort();
    controller = null;
    check.disabled = false;
  }

  function clearSuggestions(): void {
    issues = [];
    if (markedModel && !markedModel.isDisposed()) monaco.editor.setModelMarkers(markedModel, 'eaw-ai', []);
    markedModel = null;
    for (const button of results.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
  }

  function renderMarkers(): void {
    if (!snapshot || !current(snapshot)) return;
    markedModel = snapshot.model;
    monaco.editor.setModelMarkers(markedModel, 'eaw-ai', issues.map(issue => ({
      severity: monaco.MarkerSeverity.Warning, source: uiText('Орфография и грамматика · GPT-6 Luna'),
      message: issue.reason, ...issue.range,
      endColumn: Math.max(issue.range.startColumn + 1, issue.range.endColumn),
    })));
  }

  function apply(id: string): void {
    const issue = issues.find(item => item.id === id);
    if (!issue || !snapshot) return;
    if (!current(snapshot)) {
      clearSuggestions();
      showToast(uiText('Текст изменился. Запросите ИИ заново.'), true);
      return;
    }
    const expected = issue.location.text.slice(issue.range.startColumn - issue.location.startColumn,
      issue.range.endColumn - issue.location.startColumn);
    if (snapshot.model.getValueInRange(issue.range) !== expected) { clearSuggestions(); return; }
    applying = true;
    try {
      editor.pushUndoStop();
      editor.executeEdits('eaw-ai-proofreading', [{ range: issue.range, text: issue.replacement }]);
      editor.pushUndoStop();
      snapshot.version = snapshot.model.getVersionId();
      issue.button.disabled = true;
      issues = issues.filter(item => item.id !== id);
      const shift = issue.replacement.length - expected.length;
      for (const later of issues) {
        if (later.location.line !== issue.location.line || later.location.startColumn < issue.range.endColumn) continue;
        later.location.startColumn += shift;
        later.range = new monaco.Range(later.range.startLineNumber, later.range.startColumn + shift,
          later.range.endLineNumber, later.range.endColumn + shift);
      }
      renderMarkers();
      editor.focus();
    } finally { applying = false; }
  }

  function render(result: AiResult, value: Snapshot, append = false): void {
    const suggestions = aiSuggestions(result, value.request);
    if (!append || !issues.length) results.replaceChildren();
    status.textContent = uiText('GPT-6 Luna · {0} с · токены: вход {1}, из кэша {2}, выход {3}',
      (result.durationMs / 1000).toFixed(1), result.usage.inputTokens, result.usage.cachedInputTokens ?? 0, result.usage.outputTokens);
    for (const suggestion of suggestions) {
      const location = value.locations[value.request.entries.findIndex(entry => entry.key === suggestion.key)];
      const changed = aiCorrectionRange(location.text, suggestion.text)!;
      const range = new monaco.Range(location.line, location.startColumn + changed.start,
        location.line, location.startColumn + changed.end);
      const card = document.createElement('article');
      card.className = 'ai-localisation-result';
      const title = document.createElement('strong'); title.textContent = location.key;
      const before = document.createElement('p'); before.textContent = location.text.slice(changed.start, changed.end);
      const after = document.createElement('p'); after.className = 'ai-localisation-proposal'; after.textContent = changed.text;
      const reason = document.createElement('p'); reason.textContent = suggestion.reason;
      const button = document.createElement('button'); button.textContent = uiText('Исправить');
      const issue = { id: crypto.randomUUID(), location, range, replacement: changed.text, reason: suggestion.reason, button };
      issues.push(issue);
      button.addEventListener('click', () => apply(issue.id));
      card.append(title, before, after, reason, button); results.append(card);
    }
    if (!issues.length) results.textContent = uiText('Замечаний по орфографии и грамматике нет.');
    renderMarkers();
    void refreshUsage();
    if (!value.request.automatic) {
      showToast(suggestions.length
        ? uiText('Замечаний: {0}. Наведите на подчёркнутый текст или нажмите Ctrl+.', suggestions.length)
        : uiText('Замечаний по орфографии и грамматике нет.'));
    }
  }

  function hideCountdown(): void {
    if (!countdownRange) return;
    editor.removeGlyphMarginWidget(countdownWidget);
    pendingDecoration.clear();
    countdownRange = null;
    outlined = [];
  }

  function locationRange(location: Location): Monaco.Range {
    return new monaco.Range(location.line, location.startColumn,
      location.line, location.startColumn + location.text.length);
  }

  function showCountdown(batch: ProofreadingCandidate[], seconds: number): void {
    countdown.textContent = String(seconds);
    const range = locationRange(batch[0]);
    if (range.equalsRange(countdownRange) && batch.length === outlined.length
      && batch.every((item, index) => item === outlined[index])) return;
    const wasVisible = countdownRange !== null;
    countdownRange = range;
    outlined = batch;
    pendingDecoration.set(batch.map(item => ({ range: locationRange(item), options: { className: 'ai-localisation-pending' } })));
    if (wasVisible) editor.layoutGlyphMarginWidget(countdownWidget);
    else editor.addGlyphMarginWidget(countdownWidget);
  }

  function clearPending(): void {
    clearTimeout(automaticTimer);
    automaticTimer = undefined;
    pending = [];
    pendingLanguage = null;
    hideCountdown();
  }

  function scheduleAutomatic(): void {
    clearTimeout(automaticTimer);
    automaticTimer = undefined;
    const model = editor.getModel();
    const language = proofreadingLanguage(state.relativePath);
    if (!pending.length || !model || !language || language !== pendingLanguage || !editable() || !automatic.checked
      || composing || controller || automaticController || accountController || account?.signedIn === false || dialog.open
      || !isWorkspaceVisible() || document.hidden) {
      hideCountdown();
      return;
    }
    const ranges = editor.getVisibleRanges();
    const batch: ProofreadingCandidate[] = [];
    let chars = 0;
    for (const candidate of pending) {
      if (!visible(candidate, ranges)) continue;
      const size = candidate.text.length + 12;
      if (batch.length >= MAX_AI_AUTOMATIC_ENTRIES || chars + size > MAX_AI_REQUEST_CHARS) break;
      chars += size;
      batch.push(candidate);
    }
    if (!batch.length) { hideCountdown(); return; }
    const remaining = nextCheckAt - performance.now();
    if (remaining <= 0) {
      void checkAutomatic(model, batch, language);
      return;
    }
    const seconds = Math.ceil(remaining / 1000);
    showCountdown(batch, seconds);
    automaticTimer = setTimeout(scheduleAutomatic, remaining - (seconds - 1) * 1000);
  }

  async function checkAutomatic(model: Monaco.editor.ITextModel, batch: ProofreadingCandidate[], language: ProofreadingLanguage): Promise<void> {
    const active = new AbortController();
    automaticController = active;
    hideCountdown();
    status.textContent = uiText('Проверка орфографии и грамматики…');
    // Multiple sentences in one localisation value still need distinct response IDs.
    const entries = batch.map((item, index) => ({ key: `${batchSequence}-${index}`, text: item.text }));
    batchSequence = (batchSequence + 1) % 1_000_000;
    const requestBody: AiRequest = { mode: 'review', language, automatic: true, entries };
    const path = state.path;
    const ticket = state.ticket?.id ?? '';
    let retry = false;
    try {
      const result = await request<AiResult | { retryAfterMs: number }>('run', active.signal, requestBody);
      if (active.signal.aborted || !automatic.checked || editor.getModel() !== model || state.path !== path
        || (state.ticket?.id ?? '') !== ticket || proofreadingLanguage(state.relativePath) !== language || controller || !editable()) return;
      if ('retryAfterMs' in result) {
        retry = true;
        nextCheckAt = Math.max(nextCheckAt, performance.now() + result.retryAfterMs);
        return;
      }
      if (result.model !== LOCALISATION_AI_MODEL) throw new Error(uiText('Получен ответ другой модели.'));
      const locations: Location[] = [];
      const matched: AiRequest['entries'] = [];
      batch.forEach((item, index) => {
        if (!pending.includes(item)) return;
        locations.push({ ...item });
        matched.push(entries[index]);
      });
      if (!locations.length) return;
      const existing = snapshot?.request.automatic && current(snapshot) ? snapshot : null;
      const checked = new Set(locations.map(item => `${item.line}:${item.startColumn}`));
      if (existing) {
        issues = issues.filter(issue => {
          if (!checked.has(`${issue.location.line}:${issue.location.startColumn}`)) return true;
          issue.button.closest('article')?.remove();
          return false;
        });
      } else clearSuggestions();
      const retained = new Set(issues.map(issue => issue.location));
      const keptLocations = existing?.locations.filter(item => retained.has(item)) ?? [];
      const keptEntries = existing?.request.entries.filter((_entry, index) => retained.has(existing.locations[index])) ?? [];
      const value: Snapshot = { model, path, ticket, version: model.getVersionId(),
        locations: [...keptLocations, ...locations],
        request: { ...requestBody, entries: [...keptEntries, ...matched] } };
      const keys = new Set(matched.map(entry => entry.key));
      snapshot = value;
      render({ ...result, suggestions: result.suggestions.filter(item => keys.has(item.key)) }, value, Boolean(existing));
      lastAutomaticError = '';
    } catch (error) {
      if (!active.signal.aborted && !controller) {
        const message = uiMessage(error instanceof Error ? error.message : String(error));
        status.textContent = message;
        if (message !== lastAutomaticError) showToast(uiText('Фоновая проверка недоступна: {0}', message), true);
        lastAutomaticError = message;
      }
    } finally {
      if (!retry) {
        const completed = new Set(batch);
        pending = pending.filter(item => !completed.has(item));
      }
      automaticController = null;
      scheduleAutomatic();
    }
  }

  async function run(): Promise<void> {
    clearPending();
    cancel();
    clearSuggestions();
    const id = generation;
    const active = new AbortController(); controller = active;
    check.disabled = true;
    try {
      const value = capture(); snapshot = value;
      status.textContent = uiText('Проверка орфографии и грамматики…'); results.replaceChildren();
      dialog.close(); editor.focus();
      showToast(uiText('Проверка орфографии и грамматики…'));
      const result = await request<AiResult>('run', active.signal, value.request);
      if (id !== generation) return;
      if (!current(value)) throw new Error(uiText('Текст изменился. Запросите ИИ заново.'));
      if (result.model !== LOCALISATION_AI_MODEL) throw new Error(uiText('Получен ответ другой модели.'));
      render(result, value);
    } catch (error) {
      if (id === generation && !active.signal.aborted) {
        status.textContent = uiMessage(error instanceof Error ? error.message : String(error));
        showToast(status.textContent, true);
      }
    } finally {
      if (id === generation) { controller = null; check.disabled = false; scheduleAutomatic(); }
    }
  }

  async function connection(action: 'status' | 'login' | 'logout' | 'cancel-login' = 'status'): Promise<void> {
    if (accountController) return;
    clearTimeout(accountPoll);
    const active = new AbortController();
    accountController = active;
    for (const button of [loginButton, logoutButton, cancelLoginButton, connectionButton]) button.disabled = true;
    try {
      account = await request<CodexAccountStatus>(action, active.signal, action === 'status' ? undefined : {});
      if (active.signal.aborted) return;
      loginButton.hidden = account.signedIn || Boolean(account.loginPending);
      logoutButton.hidden = !account.signedIn;
      cancelLoginButton.hidden = !account.loginPending;
      const message = account.loginPending ? uiText('Завершите вход в Codex в открывшемся браузере.')
        : account.email ? uiText('Аккаунт Codex: {0}', account.email)
        : account.signedIn ? uiText('Подключён личный аккаунт ChatGPT. Модель теста – GPT-6 Luna.')
        : account.loginFailed ? uiText('Не удалось войти в Codex. Попробуйте ещё раз.')
        : uiText('Аккаунт Codex для Review не подключён.');
      if (accountStatus.textContent !== message) accountStatus.textContent = message;
      if (account.signedIn) void refreshUsage();
      else clearUsage();
      if (action === 'logout') {
        clearPending(); clearSuggestions(); results.replaceChildren(); status.textContent = '';
      }
    } catch (error) {
      if (!active.signal.aborted) {
        accountStatus.textContent = uiMessage(error instanceof Error ? error.message : String(error));
        clearUsage();
      }
    } finally {
      accountController = null;
      if (!active.signal.aborted) {
        for (const button of [loginButton, logoutButton, cancelLoginButton, connectionButton]) button.disabled = false;
        if (account?.loginPending) accountPoll = setTimeout(() => { void connection(); }, dialog.open ? 1500 : 3000);
        scheduleAutomatic();
      }
    }
  }

  function clearUsage(): void {
    stopUsageRefresh();
    usagePanel.render(null, Boolean(account?.signedIn));
  }

  function stopUsageRefresh(): void {
    clearTimeout(usageTimer);
    usageController?.abort();
    usageController = null;
  }

  async function refreshUsage(): Promise<void> {
    if (!isWorkspaceVisible() || document.hidden) return;
    clearTimeout(usageTimer);
    usageController?.abort();
    const active = new AbortController();
    usageController = active;
    try {
      const usage = await request<CodexUsage>('usage', active.signal);
      if (usageController !== active) return;
      usagePanel.render(usage.signedIn ? usage : null);
      if (!usage.live || !usage.signedIn) return;
      const now = Date.now();
      const resetTimes = [usage.context.idleResetAt, ...(usage.rateLimits?.limits.map(item => item.resetsAt) ?? [])];
      const delay = Math.min(30_000, ...resetTimes.filter((time): time is number => time !== null && time > now)
        .map(time => Math.max(1000, time - now + 250)));
      usageTimer = setTimeout(() => { void refreshUsage(); }, delay);
    } catch {
      if (usageController === active && account?.signedIn) {
        usageTimer = setTimeout(() => { void refreshUsage(); }, 30_000);
      }
    } finally {
      if (usageController === active) usageController = null;
    }
  }

  function readAutomaticSetting(): void {
    automatic.checked = localStorage.getItem(AUTO_CHECK_KEY) === '1';
    if (!automatic.checked) {
      lastAutomaticError = '';
      clearPending();
      automaticController?.abort();
      if (snapshot?.request.automatic) clearSuggestions();
    }
  }
  readAutomaticSetting();
  const settingChanged = () => {
    localStorage.setItem(AUTO_CHECK_KEY, automatic.checked ? '1' : '0');
    readAutomaticSetting();
    const position = editor.getPosition();
    const model = editor.getModel();
    const language = proofreadingLanguage(state.relativePath);
    if (automatic.checked && position && model && language && editable()) {
      const offset = model.getOffsetAt(position);
      pending = proofreadingCandidates(model, offset, offset, language, true);
      pendingLanguage = language;
      nextCheckAt = performance.now() + AI_AUTO_INTERVAL_MS;
      scheduleAutomatic();
    }
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === AUTO_CHECK_KEY || event.key === null) readAutomaticSetting();
  };
  automatic.addEventListener('change', settingChanged);
  window.addEventListener('storage', storageChanged);
  const workspaceVisibilityChanged = () => {
    if (isWorkspaceVisible() && !document.hidden) {
      void refreshUsage();
    } else {
      stopUsageRefresh();
      usagePanel.hide();
    }
    scheduleAutomatic();
  };
  window.addEventListener('workspacevisibilitychange', workspaceVisibilityChanged);
  document.addEventListener('visibilitychange', workspaceVisibilityChanged);
  dialog.addEventListener('close', scheduleAutomatic);

  function openDialog(): void {
    usagePanel.hide();
    dialog.showModal();
    scheduleAutomatic();
    void connection();
  }

  const openButton = requiredElement('#ai-localisation-open');
  openButton.addEventListener('click', openDialog);
  requiredElement('#ai-localisation-close').addEventListener('click', () => dialog.close());
  requiredElement('#ai-localisation-cancel').addEventListener('click', () => {
    clearPending(); automaticController?.abort(); cancel(); status.textContent = uiText('Запрос ИИ отменён.');
  });
  const refreshAccount = () => { void connection(); };
  const login = () => { void connection('login'); };
  const logout = () => { void connection('logout'); };
  const cancelLogin = () => { void connection('cancel-login'); };
  connectionButton.addEventListener('click', refreshAccount);
  loginButton.addEventListener('click', login);
  logoutButton.addEventListener('click', logout);
  cancelLoginButton.addEventListener('click', cancelLogin);
  check.addEventListener('click', () => { void run(); });
  const changes = editor.onDidChangeModelContent(event => {
    if (!applying) {
      cancel(); clearSuggestions();
      if (snapshot) status.textContent = uiText('Текст изменился. Запросите ИИ заново.');
    }
    const model = editor.getModel();
    const language = proofreadingLanguage(state.relativePath);
    if (!automatic.checked || !model || event.isFlush || event.isEolChange
      || !editable() || !language) { clearPending(); return; }
    const includeEdits = !applying && !state.applyingRemote && isWorkspaceVisible() && !document.hidden;
    pending = updateProofreadingQueue(model, pendingLanguage === language ? pending : [], event.changes, includeEdits, language);
    pendingLanguage = language;
    if (includeEdits) nextCheckAt = performance.now() + AI_AUTO_INTERVAL_MS;
    scheduleAutomatic();
  });
  const models = editor.onDidChangeModel(() => { clearPending(); cancel(); clearSuggestions(); snapshot = null; });
  const scrolling = editor.onDidScrollChange(scheduleAutomatic);
  const layout = editor.onDidLayoutChange(scheduleAutomatic);
  const compositionStart = editor.onDidCompositionStart(() => { composing = true; scheduleAutomatic(); });
  const compositionEnd = editor.onDidCompositionEnd(() => {
    composing = false;
    nextCheckAt = performance.now() + AI_AUTO_INTERVAL_MS;
    scheduleAutomatic();
  });
  const command = monaco.editor.registerCommand('eaw.ai.applyCorrection', (_accessor, id: string) => apply(id));
  const provider = monaco.languages.registerCodeActionProvider('eaw-yaml', {
    provideCodeActions(model, range) {
      if (!snapshot || model !== snapshot.model || !current(snapshot)) return { actions: [], dispose() {} };
      const actions: Monaco.languages.CodeAction[] = issues
        .filter(issue => monaco.Range.areIntersectingOrTouching(issue.range, range))
        .map(issue => ({
          title: uiText('Исправить на «{0}»', issue.replacement), kind: 'quickfix',
          command: { id: 'eaw.ai.applyCorrection', title: uiText('Исправить'), arguments: [issue.id] },
        }));
      return { actions, dispose() {} };
    },
  });
  const action = editor.addAction({
    id: 'eaw.ai.review',
    label: uiText('Проверить орфографию и грамматику (GPT-6 Luna)'),
    precondition: '!editorReadonly && editorLangId == eaw-yaml',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 3,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyR],
    run,
  });
  const settingsAction = editor.addAction({
    id: 'eaw.ai.settings',
    label: uiText('Орфография и грамматика (тест)'),
    precondition: '!editorReadonly && editorLangId == eaw-yaml',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 4,
    run: openDialog,
  });
  workspaceVisibilityChanged();
  return { dispose() {
    clearPending(); automaticController?.abort(); cancel(); clearSuggestions();
    clearTimeout(accountPoll);
    accountController?.abort();
    connectionButton.removeEventListener('click', refreshAccount);
    loginButton.removeEventListener('click', login);
    logoutButton.removeEventListener('click', logout);
    cancelLoginButton.removeEventListener('click', cancelLogin);
    openButton.removeEventListener('click', openDialog);
    automatic.removeEventListener('change', settingChanged);
    window.removeEventListener('storage', storageChanged);
    window.removeEventListener('workspacevisibilitychange', workspaceVisibilityChanged);
    document.removeEventListener('visibilitychange', workspaceVisibilityChanged);
    dialog.removeEventListener('close', scheduleAutomatic);
    stopUsageRefresh();
    usagePanel.dispose();
    for (const disposable of [changes, models, scrolling, layout, compositionStart, compositionEnd, provider, command, action, settingsAction]) {
      disposable.dispose();
    }
  } };
}
