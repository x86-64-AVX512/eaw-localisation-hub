const STATUS_LABELS = Object.freeze({
  draft: 'Черновик', in_progress: 'В работе', review: 'На проверке',
  needs_changes: 'Нужны исправления', ready: 'Готов к применению',
  git_conflict: 'Конфликт Git', applied: 'Применён', closed: 'Закрыт',
});

const EVENT_LABELS = Object.freeze({
  created: 'Тикет создан', status_changed: 'Изменён статус', metadata_changed: 'Изменены данные',
  files_changed: 'Изменён список файлов', rebased: 'Обновлена база Git',
  git_conflict: 'Обнаружен конфликт Git', applied: 'Применён к основной версии', archived: 'Архивирован',
});

function fileLines(value) {
  return [...new Set(String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))];
}

function localDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function createTicketPanel(options) {
  const { monaco, state, token, requestedPath, showToast } = options;
  const selector = document.querySelector('#ticket-select');
  const status = document.querySelector('#ticket-status');
  const createButton = document.querySelector('#ticket-create');
  const catalogButton = document.querySelector('#ticket-catalog');
  const createDialog = document.querySelector('#ticket-dialog');
  const createTitle = document.querySelector('#ticket-title');
  const createDescription = document.querySelector('#ticket-description');
  const createFiles = document.querySelector('#ticket-files');
  const createSubmit = document.querySelector('#ticket-submit');
  const catalog = document.querySelector('#ticket-catalog-dialog');
  const search = document.querySelector('#ticket-search');
  const filterStatus = document.querySelector('#ticket-filter-status');
  const showArchived = document.querySelector('#ticket-show-archived');
  const list = document.querySelector('#ticket-list');
  const detailsEmpty = document.querySelector('#ticket-details-empty');
  const details = document.querySelector('#ticket-details-content');
  const detailsTitle = document.querySelector('#ticket-details-title');
  const detailsMeta = document.querySelector('#ticket-details-meta');
  const editTitle = document.querySelector('#ticket-edit-title');
  const editDescription = document.querySelector('#ticket-edit-description');
  const editFiles = document.querySelector('#ticket-edit-files');
  const diff = document.querySelector('#ticket-diff-summary');
  const diffFiles = document.querySelector('#ticket-diff-files');
  const diffContainer = document.querySelector('#ticket-diff-editor');
  const events = document.querySelector('#ticket-events');
  const operationButtons = ['ticket-rebase', 'ticket-apply', 'ticket-archive', 'ticket-delete'];
  let tickets = [];
  let selectedId = '';
  let retryTimer = 0;
  let retryDelay = 2_000;
  let unavailable = false;
  let disposed = false;
  let diffEditor = null;
  let diffModels = [];
  let diffRequest = 0;

  function disposeDiff() {
    diffEditor?.dispose(); diffEditor = null;
    for (const model of diffModels) model.dispose();
    diffModels = [];
    diffContainer.replaceChildren();
  }

  async function showFileDiff(ticket, file, button) {
    const requestId = ++diffRequest;
    disposeDiff();
    for (const candidate of diffFiles.children) candidate.classList.toggle('active', candidate === button);
    diffContainer.textContent = 'Загрузка diff…';
    let payload;
    try { payload = await api(`/api/tickets/${ticket.id}/diff?file=${encodeURIComponent(file.path)}`); }
    catch (error) { diffContainer.textContent = `Diff недоступен: ${error.message}`; return; }
    if (ticket.id !== selectedId || requestId !== diffRequest) return;
    const snapshot = payload.files[0];
    diffContainer.replaceChildren();
    const original = monaco.editor.createModel(decodeBase64(snapshot.baseTextBase64), 'eaw-yaml');
    const modified = monaco.editor.createModel(decodeBase64(snapshot.ticketTextBase64), 'eaw-yaml');
    diffModels = [original, modified];
    diffEditor = monaco.editor.createDiffEditor(diffContainer, {
      theme: 'vs-dark', readOnly: true, automaticLayout: true, minimap: { enabled: false },
      renderSideBySide: true, originalEditable: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 10 },
      wordWrap: 'on', diffWordWrap: 'on', wrappingStrategy: 'advanced',
    });
    diffEditor.setModel({ original, modified });
  }

  function setAvailability(available, error = null) {
    selector.disabled = !available;
    createButton.disabled = !available;
    catalogButton.disabled = !available;
    const explanation = available ? '' : `Тикеты временно недоступны: ${error?.message ?? 'нет связи'}. Повторная проверка выполняется автоматически.`;
    selector.title = explanation;
    createButton.title = explanation || 'Создать совместный черновик от текущего Git-коммита';
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
      if (unavailable) showToast('Доступ к тикетам восстановлен.');
      unavailable = false;
      return true;
    } catch (error) {
      setAvailability(false, error);
      if (!unavailable) showToast(`Тикеты временно недоступны: ${error.message}. Повторю запрос автоматически.`, true);
      unavailable = true;
      scheduleRetry();
      return false;
    }
  }

  async function api(route, requestOptions = {}) {
    const response = await fetch(route, {
      ...requestOptions,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(requestOptions.headers ?? {}) },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function navigate(ticket) {
    const path = ticket && !ticket.files.includes(state.relativePath) ? ticket.files[0] : requestedPath;
    const hash = new URLSearchParams({ token, path });
    if (ticket) hash.set('ticket', ticket.id);
    location.hash = hash.toString();
    location.reload();
  }

  function currentTicket() {
    return tickets.find((ticket) => ticket.id === selectedId) ?? null;
  }

  function renderSwitcher() {
    const current = state.ticket?.id ?? '';
    selector.replaceChildren(new Option(`Основная версия · ${state.workspace}`, '', false, !current));
    for (const ticket of tickets.filter((item) => !item.archivedAt && item.files.includes(state.relativePath))) {
      selector.add(new Option(`${ticket.title} · ${STATUS_LABELS[ticket.status] ?? ticket.status}`, ticket.id, false, ticket.id === current));
    }
    status.hidden = !state.ticket;
    if (state.ticket) {
      if (![...status.options].some((option) => option.value === state.ticket.status)) {
        status.add(new Option(STATUS_LABELS[state.ticket.status] ?? state.ticket.status, state.ticket.status));
      }
      status.value = state.ticket.status;
      status.disabled = ['applied', 'git_conflict'].includes(state.ticket.status) || Boolean(state.ticket.archivedAt);
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
      meta.textContent = `${STATUS_LABELS[ticket.status] ?? ticket.status} · ${ticket.files.length} файл(а/ов) · ${localDate(ticket.updatedAt)}`;
      button.append(title, meta);
      button.addEventListener('click', () => { selectedId = ticket.id; renderList(); renderDetails(); });
      list.append(button);
    }
  }

  async function renderSummary(ticket) {
    diff.textContent = 'Подсчёт изменений…';
    diffFiles.replaceChildren(); disposeDiff();
    try {
      const summary = await api(`/api/tickets/${ticket.id}/diff`);
      if (ticket.id !== selectedId) return;
      diff.textContent = `Файлов в тикете: ${summary.files.length}. Diff загружается только для выбранного файла.`;
      for (const file of summary.files) {
        const button = document.createElement('button');
        button.textContent = file.path;
        button.addEventListener('click', () => showFileDiff(ticket, file, button));
        diffFiles.append(button);
      }
      if (summary.files[0]) showFileDiff(ticket, summary.files[0], diffFiles.firstElementChild);
    } catch (error) {
      diff.textContent = `Diff недоступен: ${error.message}`;
    }
  }

  function renderDetails() {
    const ticket = currentTicket();
    details.hidden = !ticket;
    detailsEmpty.hidden = Boolean(ticket);
    if (!ticket) return;
    detailsTitle.textContent = ticket.title;
    detailsMeta.textContent = `${STATUS_LABELS[ticket.status] ?? ticket.status} · ${ticket.baseBranch} @ ${ticket.baseCommit.slice(0, 12)} · автор ${ticket.creator}`;
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
    const readOnly = Boolean(ticket.archivedAt) || ['applied', 'closed'].includes(ticket.status);
    editTitle.disabled = readOnly;
    editDescription.disabled = readOnly;
    editFiles.disabled = readOnly;
    document.querySelector('#ticket-save-metadata').disabled = readOnly;
    document.querySelector('#ticket-save-files').disabled = readOnly;
    document.querySelector('#ticket-rebase').disabled = readOnly;
    document.querySelector('#ticket-apply').disabled = readOnly;
    document.querySelector('#ticket-archive').disabled = Boolean(ticket.archivedAt);
    renderSummary(ticket);
  }

  async function reload() {
    tickets = (await api('/api/tickets?archived=1')).tickets ?? [];
    if (state.ticket) state.ticket = tickets.find((ticket) => ticket.id === state.ticket.id) ?? state.ticket;
    renderSwitcher();
    renderList();
    renderDetails();
  }

  async function operation(name, path, confirmation) {
    const ticket = currentTicket();
    if (!ticket || (confirmation && !confirm(confirmation))) return;
    for (const id of operationButtons) document.querySelector(`#${id}`).disabled = true;
    try {
      const payload = await api(`/api/tickets/${ticket.id}/${path}`, { method: 'POST', body: '{}' });
      if (payload.conflicts?.length) {
        const description = payload.conflicts.map((item) => `${item.path}: ${item.keys.join(', ')}`).join('\n');
        showToast(`Операция остановлена из-за конфликтов:\n${description}`, true);
      } else {
        showToast(name);
        await reload();
        if (state.ticket?.id === ticket.id) {
          if (['apply', 'archive'].includes(path)) navigate(null);
          else if (path === 'rebase') navigate(tickets.find((item) => item.id === ticket.id) ?? ticket);
        }
      }
    } catch (error) {
      showToast(`${name} не выполнено: ${error.message}`, true);
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
      const payload = await api('/api/tickets', { method: 'POST', body: JSON.stringify({
        title: createTitle.value.trim(), description: createDescription.value.trim(), files: fileLines(createFiles.value),
      }) });
      createDialog.close();
      navigate(payload.ticket);
    } catch (error) {
      showToast(`Не удалось создать тикет: ${error.message}`, true);
    } finally { createSubmit.disabled = false; }
  });
  status.addEventListener('change', async () => {
    if (!state.ticket) return;
    try {
      const payload = await api(`/api/tickets/${state.ticket.id}`, { method: 'PATCH', body: JSON.stringify({ status: status.value }) });
      state.ticket = payload.ticket;
      await reload();
      showToast('Статус тикета обновлён.');
    } catch (error) {
      status.value = state.ticket.status;
      showToast(`Не удалось обновить тикет: ${error.message}`, true);
    }
  });
  catalogButton.addEventListener('click', () => { selectedId = state.ticket?.id ?? tickets[0]?.id ?? ''; renderList(); renderDetails(); catalog.showModal(); });
  document.querySelector('#ticket-catalog-close').addEventListener('click', () => catalog.close());
  for (const name of Object.keys(STATUS_LABELS)) filterStatus.add(new Option(STATUS_LABELS[name], name));
  search.addEventListener('input', renderList);
  filterStatus.addEventListener('change', renderList);
  showArchived.addEventListener('change', renderList);
  document.querySelector('#ticket-open').addEventListener('click', () => navigate(currentTicket()));
  document.querySelector('#ticket-save-metadata').addEventListener('click', async () => {
    const ticket = currentTicket();
    if (!ticket) return;
    try {
      await api(`/api/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify({ title: editTitle.value, description: editDescription.value }) });
      await reload(); showToast('Название и описание сохранены.');
    } catch (error) { showToast(`Не удалось сохранить: ${error.message}`, true); }
  });
  document.querySelector('#ticket-save-files').addEventListener('click', async () => {
    const ticket = currentTicket();
    if (!ticket) return;
    try {
      const payload = await api(`/api/tickets/${ticket.id}/files`, { method: 'PUT', body: JSON.stringify({ files: fileLines(editFiles.value) }) });
      await reload(); showToast('Список файлов сохранён.');
      if (state.ticket?.id === ticket.id && !payload.ticket.files.includes(state.relativePath)) navigate(payload.ticket);
    } catch (error) { showToast(`Не удалось изменить файлы: ${error.message}`, true); }
  });
  document.querySelector('#ticket-rebase').addEventListener('click', () => operation('База тикета обновлена.', 'rebase', 'Обновить тикет относительно текущего Git-коммита?'));
  document.querySelector('#ticket-apply').addEventListener('click', () => operation('Тикет применён к основной версии.', 'apply', 'Применить все файлы тикета к основной совместной версии и локальным файлам?'));
  document.querySelector('#ticket-archive').addEventListener('click', () => operation('Тикет архивирован.', 'archive', 'Архивировать тикет?'));
  document.querySelector('#ticket-delete').addEventListener('click', async () => {
    const ticket = currentTicket();
    if (!ticket || !confirm(`Навсегда удалить тикет «${ticket.title}», его документы и историю?`)) return;
    try {
      await api(`/api/tickets/${ticket.id}`, { method: 'DELETE' });
      const wasCurrent = state.ticket?.id === ticket.id;
      selectedId = '';
      await reload();
      showToast('Тикет удалён.');
      if (wasCurrent) navigate(null);
    } catch (error) { showToast(`Не удалось удалить тикет: ${error.message}`, true); }
  });

  return {
    async initialise() { await reloadWithRetry(); },
    dispose() {
      disposed = true;
      disposeDiff();
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = 0;
    },
  };
}
import { decodeBase64 } from './review-utilities.js';
