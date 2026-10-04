import { uiText, uiLocale } from '../../../packages/shared/src/ui-language.mts';
import { isModContributorOnly, canEditDocument } from '../../../packages/shared/src/document-permissions.mts';
import { decodeBase64 } from './review-utilities.ts';
import { reviewFontFamily } from './editor-font.ts';
import { createTicketCatalogWatch } from './ticket-catalog-watch.ts';
import { confirmAction } from './confirm-action.ts';
import {
  requiredButton, requiredDialog, requiredElement, requiredInput, requiredSelect, requiredTextArea,
} from './dom-elements.ts';
import type * as Monaco from 'monaco-editor';
import { embeddedSessionId, postWorkspace } from './workspace-bridge.ts';

interface TicketEvent { type: string; actor: string; at: string }

export interface Ticket {
  id: string;
  title: string;
  description: string;
  files: string[];
  status: string;
  updatedAt: string;
  baseBranch: string;
  baseCommit: string;
  creator: string;
  creatorId?: string;
  events: TicketEvent[];
  archivedAt?: string | null;
  deleted?: boolean;
}

interface TicketPanelState {
  userId?: string;
  roles?: string[];
  relativePath: string;
  workspace: string;
  ticket: Ticket | null;
}

interface TicketPanelOptions {
  monaco: typeof Monaco;
  state: TicketPanelState;
  token: string;
  requestedPath: string;
  showToast: (message: string, isError?: boolean) => void;
  editor?: Monaco.editor.IStandaloneCodeEditor;
  beforeNavigate?: () => Promise<unknown> | void;
}

interface DiffFile { path: string; baseTextBase64: string; ticketTextBase64: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  draft: uiText("Черновик"), in_progress: uiText("В работе"), review: uiText("На проверке"),
  needs_changes: uiText("Нужны исправления"), ready: uiText("Готов к применению"),
  git_conflict: uiText("Конфликт Git"), applied: uiText("Применён"), closed: uiText("Закрыт"),
});

const EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  created: uiText("Тикет создан"), status_changed: uiText("Изменён статус"), metadata_changed: uiText("Изменены данные"),
  files_changed: uiText("Изменён список файлов"), rebased: uiText("Обновлена база Git"),
  git_conflict: uiText("Обнаружен конфликт Git"), applied: uiText("Применён к основной версии"), archived: uiText("Архивирован"),
});

function fileLines(value: unknown): string[] {
  return [...new Set(String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))];
}

function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(uiLocale());
}

export function createTicketPanel(options: TicketPanelOptions) {
  const { monaco, state, token, requestedPath, showToast } = options;
  const selector = requiredSelect('#ticket-select');
  const status = requiredSelect('#ticket-status');
  const createButton = requiredButton('#ticket-create');
  const catalogButton = requiredButton('#ticket-catalog');
  const createDialog = requiredDialog('#ticket-dialog');
  const createTitle = requiredInput('#ticket-title');
  const createDescription = requiredTextArea('#ticket-description');
  const createFiles = requiredTextArea('#ticket-files');
  const createSubmit = requiredButton('#ticket-submit');
  const catalog = requiredDialog('#ticket-catalog-dialog');
  const search = requiredInput('#ticket-search');
  const filterStatus = requiredSelect('#ticket-filter-status');
  const showArchived = requiredInput('#ticket-show-archived');
  const list = requiredElement<HTMLElement>('#ticket-list');
  const detailsEmpty = requiredElement<HTMLElement>('#ticket-details-empty');
  const details = requiredElement<HTMLElement>('#ticket-details-content');
  const detailsTitle = requiredElement<HTMLElement>('#ticket-details-title');
  const detailsMeta = requiredElement<HTMLElement>('#ticket-details-meta');
  const editTitle = requiredInput('#ticket-edit-title');
  const editDescription = requiredTextArea('#ticket-edit-description');
  const editFiles = requiredTextArea('#ticket-edit-files');
  const diff = requiredElement<HTMLElement>('#ticket-diff-summary');
  const diffFiles = requiredElement<HTMLElement>('#ticket-diff-files');
  const diffContainer = requiredElement<HTMLElement>('#ticket-diff-editor');
  const events = requiredElement<HTMLElement>('#ticket-events');
  const operationButtons = ['ticket-rebase', 'ticket-apply', 'ticket-archive', 'ticket-delete'];
  let tickets: Ticket[] = [];
  let selectedId = '';
  let retryTimer = 0;
  let retryDelay = 2_000;
  let unavailable = false;
  let disposed = false;
  let navigating = false;
  let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
  let diffModels: Monaco.editor.ITextModel[] = [];
  let diffRequest = 0;
  let summaryRequest = 0;
  let catalogRevision = '';
  let dirtyDetails = false;
  const watch = createTicketCatalogWatch({
    refresh: () => reloadWithRetry(),
    revision: () => api<{ revision: string }>('/api/tickets/revision'), currentRevision: () => catalogRevision,
  });
  for (const input of [editTitle, editDescription, editFiles]) input.addEventListener('input', () => { dirtyDetails = true; });

  function disposeDiff() {
    diffEditor?.dispose(); diffEditor = null;
    for (const model of diffModels) model.dispose();
    diffModels = [];
    diffContainer.replaceChildren();
  }

  function suspendCatalogDiff() {
    summaryRequest += 1;
    diffRequest += 1;
    disposeDiff();
  }

  function closeCatalog() {
    suspendCatalogDiff();
    if (catalog.open) catalog.close();
  }

  async function showFileDiff(ticket: Ticket, file: { path: string }, button: Element): Promise<void> {
    const requestId = ++diffRequest;
    disposeDiff();
    for (const candidate of diffFiles.children) candidate.classList.toggle('active', candidate === button);
    diffContainer.textContent = uiText("Загрузка diff…");
    let payload: { files: DiffFile[] };
    try { payload = await api<{ files: DiffFile[] }>(`/api/tickets/${ticket.id}/diff?file=${encodeURIComponent(file.path)}`); }
    catch (error) {
      if (catalog.open && ticket.id === selectedId && requestId === diffRequest) {
        diffContainer.textContent = uiText("Diff недоступен: {0}", errorMessage(error));
      }
      return;
    }
    if (!catalog.open || ticket.id !== selectedId || requestId !== diffRequest) return;
    const snapshot = payload.files[0];
    if (!snapshot) { diffContainer.textContent = uiText("Файл отсутствует в diff."); return; }
    diffContainer.replaceChildren();
    const original = monaco.editor.createModel(decodeBase64(snapshot.baseTextBase64), 'eaw-yaml');
    const modified = monaco.editor.createModel(decodeBase64(snapshot.ticketTextBase64), 'eaw-yaml');
    diffModels = [original, modified];
    diffEditor = monaco.editor.createDiffEditor(diffContainer, {
      readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontFamily: reviewFontFamily(),
      renderSideBySide: true, originalEditable: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 10 },
      wordWrap: 'on', diffWordWrap: 'on', wrappingStrategy: 'advanced',
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
    });
    diffEditor.setModel({ original, modified });
  }

  function setAvailability(available: boolean, error: unknown = null): void {
    selector.disabled = !available;
    createButton.disabled = !available;
    catalogButton.disabled = !available;
    const explanation = available ? '' : uiText("Тикеты временно недоступны: {0}. Повторная проверка выполняется автоматически.", error ? errorMessage(error) : uiText("нет связи"));
    selector.title = explanation;
    createButton.title = explanation || uiText("Создать совместный черновик от текущего Git-коммита");
    catalogButton.title = explanation;
  }

  function scheduleRetry() {
    if (disposed || retryTimer) return;
    retryTimer = window.setTimeout(async () => {
      retryTimer = 0;
      await reloadWithRetry();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  }

  async function reloadWithRetry() {
    try {
      await reload();
      setAvailability(true);
      retryDelay = 2_000;
      if (unavailable) showToast(uiText("Доступ к тикетам восстановлен."));
      unavailable = false;
      return true;
    } catch (error) {
      setAvailability(false, error);
      if (!unavailable) showToast(uiText("Тикеты временно недоступны: {0}. Повторю запрос автоматически.", errorMessage(error)), true);
      unavailable = true;
      scheduleRetry();
      return false;
    }
  }

  async function api<T>(route: string, requestOptions: RequestInit & { headers?: Record<string, string> } = {}): Promise<T> {
    const response = await fetch(route, {
      ...requestOptions,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(requestOptions.headers ?? {}) },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  async function navigate(ticket: Ticket | null | undefined, replaceCurrent = false): Promise<void> {
    if (navigating) return;
    navigating = true;
    const path = ticket && !ticket.files.includes(state.relativePath) ? ticket.files[0] ?? requestedPath : requestedPath;
    if (embeddedSessionId()) { postWorkspace('navigate',{path,ticket:ticket?.id ?? '',replaceCurrent}); navigating = false; return; }
    const hash = new URLSearchParams({ token, path });
    if (ticket) hash.set('ticket', ticket.id);
    await options.beforeNavigate?.();
    location.hash = hash.toString();
    location.reload();
  }

  function currentTicket(): Ticket | null {
    return tickets.find((ticket) => ticket.id === selectedId) ?? null;
  }

  function leaveUnavailable(reason = 'deleted'): void {
    if (navigating || !state.ticket) return;
    showToast(reason === 'file-removed'
      ? uiText("Файл удалён из открытого тикета. Переход к основной версии…")
      : uiText("Открытый тикет удалён. Переход к основной версии…"));
    void navigate(null,true);
  }

  function renderSwitcher() {
    const activeTicket = state.ticket;
    const current = activeTicket?.id ?? '';
    selector.replaceChildren(new Option(uiText("Основная версия · {0}", state.workspace), '', false, !current));
    for (const ticket of tickets.filter((item) => !item.archivedAt && item.files.includes(state.relativePath))) {
      selector.add(new Option(`${ticket.title} · ${STATUS_LABELS[ticket.status] ?? ticket.status}`, ticket.id, false, ticket.id === current));
    }
    status.hidden = !activeTicket;
    if (activeTicket) {
      if (![...status.options].some((option) => option.value === activeTicket.status)) {
        status.add(new Option(STATUS_LABELS[activeTicket.status] ?? activeTicket.status, activeTicket.status));
      }
      status.value = activeTicket.status;
      const restricted = isModContributorOnly(state);
      status.disabled = (restricted && activeTicket.creatorId !== state.userId)
        || ['applied', 'git_conflict'].includes(activeTicket.status) || Boolean(activeTicket.archivedAt);
      for (const option of status.options) option.disabled = restricted && ['ready', 'needs_changes'].includes(option.value);
    }
  }

  function filteredTickets() {
    const query = search.value.trim().toLocaleLowerCase();
    return tickets.filter((ticket) => (showArchived.checked || !ticket.archivedAt)
      && (!filterStatus.value || ticket.status === filterStatus.value)
      && (!query || `${ticket.title}\n${ticket.description}\n${ticket.files.join('\n')}`.toLocaleLowerCase().includes(query)));
  }

  function renderList() {
    list.replaceChildren();
    for (const ticket of filteredTickets()) {
      const button = document.createElement('button');
      button.className = `ticket-list-item${ticket.id === selectedId ? ' selected' : ''}`;
      const title = document.createElement('strong');
      title.textContent = ticket.title;
      const meta = document.createElement('span');
      meta.textContent = uiText("{0} · {1} файл(а/ов) · {2}", STATUS_LABELS[ticket.status] ?? ticket.status, ticket.files.length, localDate(ticket.updatedAt));
      button.append(title, meta);
      button.addEventListener('click', () => { selectedId = ticket.id; dirtyDetails = false; renderList(); renderDetails(); });
      list.append(button);
    }
  }

  async function renderSummary(ticket: Ticket): Promise<void> {
    const requestId = ++summaryRequest;
    diffRequest += 1;
    diff.textContent = uiText("Подсчёт изменений…");
    diffFiles.replaceChildren(); disposeDiff();
    try {
      const summary = await api<{ files: Array<{ path: string }> }>(`/api/tickets/${ticket.id}/diff`);
      if (!catalog.open || ticket.id !== selectedId || requestId !== summaryRequest) return;
      diff.textContent = uiText("Файлов в тикете: {0}. Diff загружается только для выбранного файла.", summary.files.length);
      for (const file of summary.files) {
        const button = document.createElement('button');
        button.textContent = file.path;
        button.addEventListener('click', () => showFileDiff(ticket, file, button));
        diffFiles.append(button);
      }
      const firstButton = diffFiles.firstElementChild;
      if (summary.files[0] && firstButton) void showFileDiff(ticket, summary.files[0], firstButton);
    } catch (error) {
      if (catalog.open && ticket.id === selectedId && requestId === summaryRequest) {
        diff.textContent = uiText("Diff недоступен: {0}", errorMessage(error));
      }
    }
  }

  function renderDetails() {
    const ticket = currentTicket();
    details.hidden = !ticket;
    detailsEmpty.hidden = Boolean(ticket);
    if (!ticket) return;
    detailsTitle.textContent = ticket.title;
    detailsMeta.textContent = uiText("{0} · {1} @ {2} · автор {3}", STATUS_LABELS[ticket.status] ?? ticket.status, ticket.baseBranch, ticket.baseCommit.slice(0, 12), ticket.creator);
    editTitle.value = ticket.title;
    editDescription.value = ticket.description;
    editFiles.value = ticket.files.join('\n');
    events.replaceChildren();
    for (const event of [...ticket.events].reverse()) {
      const item = document.createElement('div');
      item.className = 'ticket-event';
      const text = document.createElement('div');
      text.textContent = `${EVENT_LABELS[event.type] ?? event.type} · ${event.actor}`;
      const time = document.createElement('time');
      time.textContent = localDate(event.at);
      item.append(text, time);
      events.append(item);
    }
    const restricted = isModContributorOnly(state);
    const managedByOther = restricted && ticket.creatorId !== state.userId;
    const readOnly = managedByOther || Boolean(ticket.archivedAt) || ['applied', 'closed'].includes(ticket.status);
    editTitle.disabled = readOnly;
    editDescription.disabled = readOnly;
    editFiles.disabled = readOnly;
    requiredButton('#ticket-save-metadata').disabled = readOnly;
    requiredButton('#ticket-save-files').disabled = readOnly;
    requiredButton('#ticket-rebase').disabled = readOnly || ticket.files.some((file) => !canEditDocument(state, file));
    requiredButton('#ticket-apply').disabled = readOnly || restricted;
    requiredButton('#ticket-archive').disabled = managedByOther || Boolean(ticket.archivedAt);
    requiredButton('#ticket-delete').disabled = managedByOther;
    if (catalog.open) void renderSummary(ticket);
  }

  async function reload() {
    const payload = await api<{ tickets?: Ticket[]; revision?: string }>('/api/tickets?archived=1');
    if (disposed) return;
    const draft = dirtyDetails ? { id: selectedId, title: editTitle.value, description: editDescription.value, files: editFiles.value } : null;
    tickets = payload.tickets ?? [];
    catalogRevision = payload.revision ?? '';
    if (selectedId && !currentTicket()) { selectedId = ''; dirtyDetails = false; }
    const activeTicket = state.ticket;
    if (activeTicket) {
      const current = tickets.find((ticket) => ticket.id === activeTicket.id);
      if (!current) { leaveUnavailable(); return; }
      state.ticket = current;
      if (current.archivedAt || ['applied', 'closed'].includes(current.status)) {
        options.editor?.updateOptions({ readOnly: true });
      }
    }
    renderSwitcher();
    renderList();
    renderDetails();
    if (draft && draft.id === selectedId) {
      editTitle.value = draft.title; editDescription.value = draft.description; editFiles.value = draft.files;
    }
  }

  async function operation(name: string, path: string, confirmation: string): Promise<void> {
    const ticket = currentTicket();
    if (!ticket || (confirmation && !await confirmAction(document.querySelector(`#ticket-${path}`), confirmation))) return;
    for (const id of operationButtons) requiredButton(`#${id}`).disabled = true;
    try {
      const payload = await api<{ conflicts?: Array<{ path: string; keys: string[] }> }>(
        `/api/tickets/${ticket.id}/${path}`, { method: 'POST', body: '{}' },
      );
      if (payload.conflicts?.length) {
        const description = payload.conflicts.map((item) => `${item.path}: ${item.keys.join(', ')}`).join('\n');
        showToast(uiText("Операция остановлена из-за конфликтов:\n{0}", description), true);
      } else {
        showToast(name);
        await reload();
        if (state.ticket?.id === ticket.id) {
          if (['apply', 'archive'].includes(path)) navigate(null);
          else if (path === 'rebase') navigate(tickets.find((item) => item.id === ticket.id) ?? ticket);
        }
      }
    } catch (error) {
      showToast(uiText("{0} не выполнено: {1}", name, errorMessage(error)), true);
    } finally {
      renderDetails();
    }
  }

  selector.addEventListener('change', () => navigate(tickets.find((ticket) => ticket.id === selector.value)));
  createButton.addEventListener('click', () => {
    createTitle.value = '';
    createDescription.value = '';
    createFiles.value = state.relativePath;
    createDialog.showModal();
    createTitle.focus();
  });
  createSubmit.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!createTitle.value.trim()) return;
    createSubmit.disabled = true;
    try {
      const payload = await api<{ ticket: Ticket }>('/api/tickets', { method: 'POST', body: JSON.stringify({
        title: createTitle.value.trim(), description: createDescription.value.trim(), files: fileLines(createFiles.value),
      }) });
      createDialog.close();
      navigate(payload.ticket);
    } catch (error) {
      showToast(uiText("Не удалось создать тикет: {0}", errorMessage(error)), true);
    } finally { createSubmit.disabled = false; }
  });
  status.addEventListener('change', async () => {
    if (!state.ticket) return;
    try {
      const payload = await api<{ ticket: Ticket }>(`/api/tickets/${state.ticket.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: status.value }),
      });
      state.ticket = payload.ticket;
      await reload();
      showToast(uiText("Статус тикета обновлён."));
    } catch (error) {
      status.value = state.ticket.status;
      showToast(uiText("Не удалось обновить тикет: {0}", errorMessage(error)), true);
    }
  });
  catalogButton.addEventListener('click', () => {
    selectedId = state.ticket?.id ?? tickets[0]?.id ?? ''; dirtyDetails = false;
    catalog.showModal(); renderList(); renderDetails(); watch.changed();
  });
  requiredButton('#ticket-catalog-close').addEventListener('click', closeCatalog);
  catalog.addEventListener('close', suspendCatalogDiff);
  for (const name of Object.keys(STATUS_LABELS)) filterStatus.add(new Option(STATUS_LABELS[name], name));
  search.addEventListener('input', renderList);
  filterStatus.addEventListener('change', renderList);
  showArchived.addEventListener('change', renderList);
  requiredButton('#ticket-open').addEventListener('click', () => navigate(currentTicket()));
  requiredButton('#ticket-save-metadata').addEventListener('click', async () => {
    const ticket = currentTicket();
    if (!ticket) return;
    try {
      await api(`/api/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify({ title: editTitle.value, description: editDescription.value }) });
      dirtyDetails = false; await reload(); showToast(uiText("Название и описание сохранены."));
    } catch (error) { showToast(uiText("Не удалось сохранить: {0}", errorMessage(error)), true); }
  });
  requiredButton('#ticket-save-files').addEventListener('click', async () => {
    const ticket = currentTicket();
    if (!ticket) return;
    try {
      const payload = await api<{ ticket: Ticket }>(`/api/tickets/${ticket.id}/files`, {
        method: 'PUT', body: JSON.stringify({ files: fileLines(editFiles.value) }),
      });
      dirtyDetails = false; await reload(); showToast(uiText("Список файлов сохранён."));
      if (state.ticket?.id === ticket.id && !payload.ticket.files.includes(state.relativePath)) navigate(payload.ticket);
    } catch (error) { showToast(uiText("Не удалось изменить файлы: {0}", errorMessage(error)), true); }
  });
  requiredButton('#ticket-rebase').addEventListener('click', () => operation(uiText("База тикета обновлена."), 'rebase', uiText("Обновить тикет относительно текущего Git-коммита?")));
  requiredButton('#ticket-apply').addEventListener('click', () => operation(uiText("Тикет применён к основной версии."), 'apply', uiText("Применить все файлы тикета к основной совместной версии и локальным файлам?")));
  requiredButton('#ticket-archive').addEventListener('click', () => operation(uiText("Тикет архивирован."), 'archive', uiText("Архивировать тикет?")));
  requiredButton('#ticket-delete').addEventListener('click', async () => {
    const ticket = currentTicket();
    const button = requiredButton('#ticket-delete');
    if (!ticket || !await confirmAction(button, uiText("Удалить тикет «{0}» вместе с документами и историей?", ticket.title), { label: uiText("Удалить"), danger: true })) return;
    button.disabled = true;
    closeCatalog();
    try {
      await api(`/api/tickets/${ticket.id}`, { method: 'DELETE' });
      const wasCurrent = state.ticket?.id === ticket.id;
      selectedId = '';
      await reload();
      showToast(uiText("Тикет удалён."));
      if (wasCurrent) navigate(null);
    } catch (error) { showToast(uiText("Не удалось удалить тикет: {0}", errorMessage(error)), true); }
    finally { button.disabled = false; }
  });

  return {
    refresh: (revision?: string) => watch.changed(revision),
    leaveUnavailable,
    async initialise() { await reloadWithRetry(); },
    dispose() {
      disposed = true;
      watch.dispose();
      disposeDiff();
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = 0;
    },
  };
}
