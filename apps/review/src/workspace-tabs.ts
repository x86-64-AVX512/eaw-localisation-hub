import { requiredElement } from './dom-elements.ts';

const STORAGE_KEY = 'eaw-hub-workspace-tabs-v1';
const MAX_TABS = 20;

interface WorkspaceTab {
  path: string;
  ticket: string;
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

function identity(path: string, ticket = ''): string {
  return `${String(path).replaceAll('\\', '/').toLocaleLowerCase()}\0${ticket}`;
}

function labelFor(tab: WorkspaceTab): string {
  return tab.relativePath || String(tab.path).replaceAll('\\', '/').split('/').at(-1) || 'Файл';
}

export function createWorkspaceTabs({ token, requestedPath, requestedTicket, readOnlyMode, showToast }: WorkspaceTabsOptions) {
  const bar = requiredElement<HTMLElement>('#document-tabs'); const list = requiredElement<HTMLElement>('#document-tab-list');
  const add = requiredElement<HTMLButtonElement>('#document-tab-add'); const dialog = requiredElement<HTMLDialogElement>('#file-picker-dialog');
  const search = requiredElement<HTMLInputElement>('#file-picker-search'); const files = requiredElement<HTMLElement>('#file-picker-files');
  let state = load(); let currentKey = identity(requestedPath, requestedTicket);
  if (readOnlyMode === 'english') bar.hidden = true;
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function navigate(tab: WorkspaceTab): void {
    const hash = new URLSearchParams({ token, path: tab.path });
    if (tab.ticket) hash.set('ticket', tab.ticket);
    location.hash = hash.toString(); location.reload();
  }
  function render() {
    list.replaceChildren();
    for (const tab of state.tabs) {
      const key = identity(tab.path, tab.ticket);
      const button = document.createElement('button'); button.className = `document-tab${key === currentKey ? ' active' : ''}`;
      button.title = labelFor(tab);
      const text = document.createElement('span'); text.textContent = labelFor(tab);
      const close = document.createElement('span'); close.className = 'document-tab-close'; close.textContent = '×';
      close.setAttribute('role', 'button'); close.setAttribute('aria-label', `Закрыть ${labelFor(tab)}`);
      close.addEventListener('click', (event) => {
        event.stopPropagation(); const index = state.tabs.findIndex((item) => identity(item.path, item.ticket) === key);
        state.tabs.splice(index, 1); save();
        if (key === currentKey && state.tabs.length) navigate(state.tabs[Math.min(index, state.tabs.length - 1)]);
        else render();
      });
      button.append(text, close); button.addEventListener('click', () => { if (key !== currentKey) navigate(tab); });
      list.append(button);
    }
  }
  function upsert(tab: WorkspaceTab): void {
    const key = identity(tab.path, tab.ticket); const existing = state.tabs.findIndex((item) => identity(item.path, item.ticket) === key);
    if (existing >= 0) state.tabs[existing] = { ...state.tabs[existing], ...tab }; else state.tabs.push(tab);
    state.tabs = state.tabs.slice(-MAX_TABS); currentKey = key; save(); render();
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
    } catch (error) { showToast(`Не удалось получить список файлов: ${error instanceof Error ? error.message : String(error)}`, true); }
    finally { add.disabled = false; }
  }
  add.addEventListener('click', openPicker);
  requiredElement<HTMLButtonElement>('#file-picker-close').addEventListener('click', () => dialog.close());
  return {
    confirmPath(path: string, relativePath: string, ticket: { id?: string } | null) {
      if (readOnlyMode === 'english') return;
      const requestedKey = currentKey;
      const previous = state.tabs.find((item) => identity(item.path, item.ticket) === requestedKey) ?? {};
      state.tabs = state.tabs.filter((item) => identity(item.path, item.ticket) !== requestedKey);
      upsert({ ...previous, path, relativePath, ticket: ticket?.id ?? requestedTicket });
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
