const STORAGE_KEY = 'eaw-hub-workspace-tabs-v1';
const MAX_TABS = 20;

function load() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { tabs: Array.isArray(value.tabs) ? value.tabs.slice(0, MAX_TABS) : [] };
  } catch { return { tabs: [] }; }
}

function identity(path, ticket = '') {
  return `${String(path).replaceAll('\\', '/').toLocaleLowerCase()}\0${ticket}`;
}

function labelFor(tab) {
  return tab.relativePath || String(tab.path).replaceAll('\\', '/').split('/').at(-1) || 'Файл';
}

export function createWorkspaceTabs({ token, requestedPath, requestedTicket, readOnlyMode, showToast }) {
  const bar = document.querySelector('#document-tabs'); const list = document.querySelector('#document-tab-list');
  const add = document.querySelector('#document-tab-add'); const dialog = document.querySelector('#file-picker-dialog');
  const search = document.querySelector('#file-picker-search'); const files = document.querySelector('#file-picker-files');
  let state = load(); let currentKey = identity(requestedPath, requestedTicket);
  if (readOnlyMode === 'english') bar.hidden = true;
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function navigate(tab) {
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
  function upsert(tab) {
    const key = identity(tab.path, tab.ticket); const existing = state.tabs.findIndex((item) => identity(item.path, item.ticket) === key);
    if (existing >= 0) state.tabs[existing] = { ...state.tabs[existing], ...tab }; else state.tabs.push(tab);
    state.tabs = state.tabs.slice(-MAX_TABS); currentKey = key; save(); render();
  }
  if (!readOnlyMode && requestedPath) upsert({ path: requestedPath, ticket: requestedTicket, relativePath: '' });
  async function openPicker() {
    add.disabled = true;
    try {
      const response = await fetch('/api/localisation-files', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const available = payload.files ?? [];
      function renderFiles() {
        const query = search.value.trim().toLocaleLowerCase(); files.replaceChildren();
        for (const item of available.filter((entry) => entry.relativePath.toLocaleLowerCase().includes(query)).slice(0, 500)) {
          const button = document.createElement('button'); button.textContent = item.relativePath;
          button.addEventListener('click', () => navigate({ path: item.path, relativePath: item.relativePath, ticket: '' }));
          files.append(button);
        }
      }
      search.value = ''; search.oninput = renderFiles; renderFiles(); dialog.showModal(); search.focus();
    } catch (error) { showToast(`Не удалось получить список файлов: ${error.message}`, true); }
    finally { add.disabled = false; }
  }
  add.addEventListener('click', openPicker);
  document.querySelector('#file-picker-close').addEventListener('click', () => dialog.close());
  return {
    confirmPath(path, relativePath, ticket) {
      if (readOnlyMode === 'english') return;
      const requestedKey = currentKey;
      const previous = state.tabs.find((item) => identity(item.path, item.ticket) === requestedKey) ?? {};
      state.tabs = state.tabs.filter((item) => identity(item.path, item.ticket) !== requestedKey);
      upsert({ ...previous, path, relativePath, ticket: ticket?.id ?? requestedTicket });
    },
    restore(editor, path) {
      if (readOnlyMode === 'english') return;
      const tab = state.tabs.find((item) => identity(item.path, item.ticket) === currentKey
        || String(item.path).toLocaleLowerCase() === String(path).toLocaleLowerCase());
      if (!tab) return;
      if (tab.line) editor.setPosition({ lineNumber: tab.line, column: tab.column || 1 });
      if (Number.isFinite(tab.scrollTop)) editor.setScrollTop(tab.scrollTop);
    },
    remember(editor) {
      if (readOnlyMode === 'english') return;
      const tab = state.tabs.find((item) => identity(item.path, item.ticket) === currentKey); const position = editor.getPosition();
      if (!tab || !position) return;
      Object.assign(tab, { line: position.lineNumber, column: position.column, scrollTop: editor.getScrollTop() }); save();
    },
  };
}
