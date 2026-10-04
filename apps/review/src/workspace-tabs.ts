import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { requiredElement } from './dom-elements.ts';
import { embeddedSessionId, postWorkspace } from './workspace-bridge.ts';

const STORAGE_KEY = 'eaw-hub-workspace-tabs-v1';
const MAX_TABS = 20;

export interface WorkspaceTab {
  path: string;
  ticket: string;
  ticketTitle?: string;
  relativePath: string;
  line?: number;
  column?: number;
  scrollTop?: number;
}
interface AvailableFile { path: string; relativePath: string }
interface TabEditor {
  getPosition(): { lineNumber: number; column: number } | null;
  getScrollTop(): number;
  setPosition(position: { lineNumber: number; column: number }): void;
  setScrollTop(top: number): void;
}
interface WorkspaceTabsOptions {
  token: string;
  requestedPath: string;
  requestedTicket: string;
  readOnlyMode: string;
  showToast: (message: string, isError?: boolean) => void;
  onNavigate?: (tab: WorkspaceTab) => void;
  onClose?: (tab: WorkspaceTab) => boolean;
}

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  return typeof tab.path === 'string' && typeof tab.ticket === 'string'
    && typeof tab.relativePath === 'string';
}

function isAvailableFile(value: unknown): value is AvailableFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return typeof file.path === 'string' && typeof file.relativePath === 'string';
}

function load(): { tabs: WorkspaceTab[] } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const tabs = value && typeof value === 'object' && 'tabs' in value ? value.tabs : null;
    return { tabs: Array.isArray(tabs) ? tabs.filter(isWorkspaceTab).slice(0, MAX_TABS) : [] };
  } catch { return { tabs: [] }; }
}

export function workspaceTabIdentity(path: string, ticket = ''): string {
  return `${String(path).replaceAll('\\', '/').toLocaleLowerCase()}\0${ticket}`;
}
const identity = workspaceTabIdentity;

export function workspaceTabLabel(tab: WorkspaceTab): string {
  const path = (tab.relativePath || tab.path).replaceAll('\\','/'), file = path.split('/').at(-1) || uiText('Файл');
  const match = file.match(/^(.*?)(?:_l_(russian|english))?\.ya?ml$/i);
  const language = match?.[2] ?? path.match(/\/(russian|english)\//i)?.[1];
  const name = (match?.[1] || file).replace(/^country_/i,'');
  return name + (language ? ` · ${language.toLowerCase() === 'russian' ? 'RU' : 'EN'}` : '')
    + (tab.ticket ? ` · ${tab.ticketTitle || tab.ticket.slice(0,8)}` : '');
}
const labelFor = workspaceTabLabel;

export function createWorkspaceTabs({ token, requestedPath, requestedTicket, readOnlyMode, showToast, onNavigate, onClose }: WorkspaceTabsOptions) {
  const bar = requiredElement<HTMLElement>('#document-tabs'); const list = requiredElement<HTMLElement>('#document-tab-list');
  const add = requiredElement<HTMLButtonElement>('#document-tab-add'); const dialog = requiredElement<HTMLDialogElement>('#file-picker-dialog');
  const search = requiredElement<HTMLInputElement>('#file-picker-search'); const files = requiredElement<HTMLElement>('#file-picker-files');
  if (embeddedSessionId()) {
    list.hidden = true; add.hidden = true; bar.classList.add('embedded-document-tools');
    return { confirmPath:(path:string, relativePath:string, ticket:{id?:string;title?:string}|null) => postWorkspace('confirmed', {path, relativePath, ticket:ticket?.id ?? '',ticketTitle:ticket?.title}),
      restore() {}, remember(editor:TabEditor) { postWorkspace('position', {position:editor.getPosition(), scrollTop:editor.getScrollTop()}); },
      open() {}, remove() {}, entries:() => [] as WorkspaceTab[], setSleeping() {}, confirmTab() {}, rememberTab() {} };
  }
  let state = load(); let currentKey = identity(requestedPath, requestedTicket);
  let draggedKey = ''; let suppressClickUntil = 0;
  const sleeping = new Set<string>();
  if (readOnlyMode === 'english') bar.hidden = true;
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function navigate(tab: WorkspaceTab): void {
    if (onNavigate && state.tabs.length >= MAX_TABS && !state.tabs.some(item => identity(item.path,item.ticket) === identity(tab.path,tab.ticket))) {
      showToast(uiText('Можно открыть не больше 20 вкладок. Закройте одну из них.'),true); return;
    }
    if (onNavigate) { upsert(tab); dialog.close(); onNavigate(tab); return; }
    const hash = new URLSearchParams({ token, path: tab.path });
    if (tab.ticket) hash.set('ticket', tab.ticket);
    location.hash = hash.toString(); location.reload();
  }
  function clearDropHints() {
    for (const tab of list.children) tab.classList.remove('drop-before', 'drop-after');
  }
  function finishDrag() {
    draggedKey = ''; suppressClickUntil = Date.now() + 150; clearDropHints();
    for (const tab of list.children) tab.classList.remove('dragging');
  }
  function moveTab(targetKey: string | null, after = false) {
    const source = state.tabs.findIndex((tab) => identity(tab.path, tab.ticket) === draggedKey);
    if (source < 0 || targetKey === draggedKey) { finishDrag(); return; }
    const [tab] = state.tabs.splice(source, 1);
    const target = targetKey === null ? state.tabs.length
      : state.tabs.findIndex((item) => identity(item.path, item.ticket) === targetKey) + Number(after);
    state.tabs.splice(Math.max(0, target), 0, tab);
    finishDrag(); save(); render();
  }
  list.addEventListener('dragover', (event) => {
    if (!draggedKey) return;
    const rect = list.getBoundingClientRect();
    if (event.clientX < rect.left + 24) list.scrollLeft -= 24;
    else if (event.clientX > rect.right - 24) list.scrollLeft += 24;
    if (event.target === list) {
      event.preventDefault(); clearDropHints(); list.lastElementChild?.classList.add('drop-after');
    }
  });
  list.addEventListener('drop', (event) => {
    if (!draggedKey || event.target !== list) return;
    event.preventDefault(); moveTab(null);
  });
  function render() {
    // Bootstrap can confirm a path while a drag is in progress. Replacing the
    // dragged DOM node must cancel it rather than leave a stale drag identity.
    if (draggedKey) finishDrag();
    list.replaceChildren();
    for (const tab of state.tabs) {
      const key = identity(tab.path, tab.ticket);
      const button = document.createElement('button'); button.className = `document-tab${key === currentKey ? ' active' : ''}`;
      if (sleeping.has(key)) button.classList.add('sleeping');
      button.draggable = true;
      button.addEventListener('dragstart', (event) => {
        if (event.target instanceof Element && event.target.closest('.document-tab-close')) { event.preventDefault(); return; }
        draggedKey = key; suppressClickUntil = Infinity; button.classList.add('dragging');
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key); }
      });
      button.addEventListener('dragend', finishDrag);
      button.addEventListener('dragover', (event) => {
        if (!draggedKey || draggedKey === key) return;
        event.preventDefault(); clearDropHints();
        const rect = button.getBoundingClientRect();
        button.classList.add(event.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });
      button.addEventListener('drop', (event) => {
        if (!draggedKey) return;
        event.preventDefault(); event.stopPropagation();
        const rect = button.getBoundingClientRect();
        moveTab(key, event.clientX >= rect.left + rect.width / 2);
      });
      button.title = (tab.relativePath || tab.path) + (tab.ticket ? ` · ${tab.ticketTitle || tab.ticket}` : '')
        + (sleeping.has(key) ? uiText(' · Спит: подключится при открытии') : '');
      const text = document.createElement('span'); text.textContent = labelFor(tab);
      const close = document.createElement('span'); close.className = 'document-tab-close'; close.textContent = '×';
      close.setAttribute('role', 'button'); close.setAttribute('aria-label', uiText("Закрыть {0}", labelFor(tab)));
      close.addEventListener('click', (event) => {
        event.stopPropagation(); if (onClose?.(tab) === false) return; remove(tab.path, tab.ticket);
      });
      button.append(text, close); button.addEventListener('click', () => {
        if (Date.now() >= suppressClickUntil && key !== currentKey) navigate(tab);
      });
      list.append(button);
    }
  }
  function remove(path: string, ticket = '') {
    const key = identity(path, ticket), index = state.tabs.findIndex(item => identity(item.path, item.ticket) === key);
    if (index < 0) return;
    state.tabs.splice(index, 1); sleeping.delete(key); save();
    if (key === currentKey && state.tabs.length) navigate(state.tabs[Math.min(index, state.tabs.length - 1)]);
    else render();
  }
  function upsert(tab: WorkspaceTab, replacingKey = identity(tab.path, tab.ticket), activate = true): void {
    const key = identity(tab.path, tab.ticket);
    const canonical = state.tabs.findIndex((item) => identity(item.path, item.ticket) === key);
    const existing = canonical >= 0 ? canonical : state.tabs.findIndex((item) => identity(item.path, item.ticket) === replacingKey);
    if (existing >= 0) state.tabs[existing] = { ...state.tabs[existing], ...tab,
      relativePath: tab.relativePath || state.tabs[existing].relativePath };
    else state.tabs.push(tab);
    if (replacingKey !== key) state.tabs = state.tabs.filter((item) => identity(item.path, item.ticket) !== replacingKey);
    state.tabs = state.tabs.slice(-MAX_TABS); if (activate || currentKey === replacingKey) currentKey = key; save(); render();
  }
  if (!readOnlyMode && requestedPath) upsert({ path: requestedPath, ticket: requestedTicket, relativePath: '' });
  async function openPicker() {
    add.disabled = true;
    try {
      const response = await fetch('/api/localisation-files', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const payload: unknown = await response.json();
      const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
      const available: AvailableFile[] = Array.isArray(data.files) ? data.files.filter(isAvailableFile) : [];
      function renderFiles() {
        const query = search.value.trim().toLocaleLowerCase(); files.replaceChildren();
        for (const item of available.filter((entry) => entry.relativePath.toLocaleLowerCase().includes(query)).slice(0, 500)) {
          const button = document.createElement('button'); button.textContent = item.relativePath;
          button.addEventListener('click', () => navigate({ path: item.path, relativePath: item.relativePath, ticket: '' }));
          files.append(button);
        }
      }
      search.value = ''; search.oninput = renderFiles; renderFiles(); dialog.showModal(); search.focus();
    } catch (error) { showToast(uiText("Не удалось получить список файлов: {0}", error instanceof Error ? error.message : String(error)), true); }
    finally { add.disabled = false; }
  }
  add.addEventListener('click', openPicker);
  requiredElement<HTMLButtonElement>('#file-picker-close').addEventListener('click', () => dialog.close());
  return {
    open: navigate,
    remove,
    entries: () => state.tabs.map(tab => ({ ...tab })),
    rememberTab(tab:WorkspaceTab) { const saved = state.tabs.find(item => identity(item.path,item.ticket) === identity(tab.path,tab.ticket)); if (saved) { Object.assign(saved,tab); save(); } },
    confirmTab(tab:WorkspaceTab, oldPath:string, oldTicket:string) { upsert(tab, identity(oldPath,oldTicket), false); },
    setSleeping(path: string, ticket: string, value: boolean) {
      const key = identity(path, ticket); if (value) sleeping.add(key); else sleeping.delete(key); render();
    },
    confirmPath(path: string, relativePath: string, ticket: { id?: string;title?:string } | null) {
      if (readOnlyMode === 'english') return;
      upsert({ path, relativePath, ticket: ticket?.id ?? requestedTicket,ticketTitle:ticket?.title }, currentKey);
    },
    restore(editor: TabEditor, path: string) {
      if (readOnlyMode === 'english') return;
      const tab = state.tabs.find((item) => identity(item.path, item.ticket) === currentKey
        || String(item.path).toLocaleLowerCase() === String(path).toLocaleLowerCase());
      if (!tab) return;
      if (tab.line) editor.setPosition({ lineNumber: tab.line, column: tab.column || 1 });
      if (typeof tab.scrollTop === 'number' && Number.isFinite(tab.scrollTop)) editor.setScrollTop(tab.scrollTop);
    },
    remember(editor: TabEditor) {
      if (readOnlyMode === 'english') return;
      const tab = state.tabs.find((item) => identity(item.path, item.ticket) === currentKey); const position = editor.getPosition();
      if (!tab || !position) return;
      Object.assign(tab, { line: position.lineNumber, column: position.column, scrollTop: editor.getScrollTop() }); save();
    },
  };
}
