import { decodeBase64 } from './review-utilities.js';

export function createGitHistoryPanel({ monaco, state, token, showToast }) {
  const openButton = document.querySelector('#git-history-open');
  const dialog = document.querySelector('#git-history-dialog');
  const list = document.querySelector('#git-history-list');
  const empty = document.querySelector('#git-history-empty');
  const more = document.querySelector('#git-history-more');
  const selection = document.querySelector('#git-history-selection');
  const fromSelect = document.querySelector('#git-history-from');
  const toSelect = document.querySelector('#git-history-to');
  const original = monaco.editor.createModel('', 'eaw-yaml');
  const modified = monaco.editor.createModel('', 'eaw-yaml');
  const diff = monaco.editor.createDiffEditor(document.querySelector('#git-history-diff'), {
    theme: 'vs-dark', readOnly: true, automaticLayout: true, minimap: { enabled: false },
    renderSideBySide: true, originalEditable: false,
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 10 },
  });
  diff.setModel({ original, modified });
  let entries = [];
  let nextOffset = 0;
  let hasMore = false;
  let loading = false;
  let comparisonId = 0;

  async function request(url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Не удалось прочитать историю Git.');
    return payload;
  }

  function entryFor(revision) {
    return revision === 'HEAD' ? null : entries.find((entry) => entry.commit === revision);
  }

  function shortLabel(revision) {
    if (revision === 'HEAD') return 'текущий HEAD';
    return entryFor(revision)?.shortCommit ?? revision.slice(0, 10);
  }

  function updateSelectors() {
    const previousFrom = fromSelect.value;
    const previousTo = toSelect.value || 'HEAD';
    for (const select of [fromSelect, toSelect]) {
      select.replaceChildren();
      const head = document.createElement('option');
      head.value = 'HEAD';
      head.textContent = 'HEAD · текущая версия Git';
      select.append(head);
      for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry.commit;
        option.textContent = `${entry.shortCommit} · ${entry.subject}`;
        select.append(option);
      }
    }
    fromSelect.value = entries.some(({ commit }) => commit === previousFrom)
      ? previousFrom : (entries[0]?.commit ?? 'HEAD');
    toSelect.value = previousTo === 'HEAD' || entries.some(({ commit }) => commit === previousTo)
      ? previousTo : 'HEAD';
  }

  function render() {
    list.replaceChildren();
    empty.hidden = entries.length > 0;
    more.hidden = !hasMore;
    more.disabled = loading;
    for (const entry of entries) {
      const item = document.createElement('button');
      const from = entry.commit === fromSelect.value;
      const to = entry.commit === toSelect.value;
      item.className = `history-item${from ? ' selected-from' : ''}${to ? ' selected-to' : ''}`;
      item.style.setProperty('--history-color', to ? '#71c995' : '#6aa9ff');
      item.innerHTML = '<strong></strong><span></span><small></small>';
      item.querySelector('strong').textContent = `${entry.shortCommit} · ${entry.author}`;
      item.querySelector('span').textContent = entry.subject;
      const date = new Date(entry.date);
      item.querySelector('small').textContent = Number.isNaN(date.valueOf()) ? '' : date.toLocaleString();
      item.title = 'Выбрать эту версию слева';
      item.addEventListener('click', () => {
        fromSelect.value = entry.commit;
        compare();
      });
      list.append(item);
    }
  }

  async function load(reset = false) {
    if (loading || !state.path) return;
    loading = true;
    if (reset) {
      entries = [];
      nextOffset = 0;
      hasMore = false;
      original.setValue('');
      modified.setValue('');
      selection.textContent = 'Загрузка истории Git…';
    }
    render();
    try {
      const query = new URLSearchParams({ path: state.path, offset: String(nextOffset), limit: '50' });
      const payload = await request(`/api/git-history?${query}`);
      entries.push(...(payload.entries ?? []).filter(
        (entry) => !entries.some((known) => known.commit === entry.commit),
      ));
      nextOffset = payload.nextOffset ?? entries.length;
      hasMore = payload.hasMore === true;
      updateSelectors();
      if (entries.length) await compare();
      else selection.textContent = 'История файла пуста';
    } catch (error) {
      selection.textContent = error.message;
      showToast(error.message, true);
    } finally {
      loading = false;
      render();
    }
  }

  async function compare() {
    const from = fromSelect.value;
    const to = toSelect.value;
    if (!from || !to) return;
    const requestId = ++comparisonId;
    selection.textContent = `${shortLabel(from)} → ${shortLabel(to)} · загрузка…`;
    original.setValue('');
    modified.setValue('');
    render();
    try {
      const fromEntry = entryFor(from);
      const toEntry = entryFor(to);
      const query = new URLSearchParams({
        path: state.path,
        from,
        to,
        fromPath: fromEntry?.historicalPath ?? state.relativePath,
        toPath: toEntry?.historicalPath ?? state.relativePath,
      });
      const payload = await request(`/api/git-history/diff?${query}`);
      if (requestId !== comparisonId) return;
      original.setValue(decodeBase64(payload.baseBase64));
      modified.setValue(decodeBase64(payload.headBase64));
      selection.textContent = `${String(payload.fromCommit).slice(0, 10)} → ${String(payload.toCommit).slice(0, 10)}`;
      diff.layout();
    } catch (error) {
      if (requestId === comparisonId) selection.textContent = error.message;
      showToast(error.message, true);
    }
  }

  openButton.addEventListener('click', () => {
    dialog.showModal();
    load(true);
  });
  fromSelect.addEventListener('change', compare);
  toSelect.addEventListener('change', compare);
  more.addEventListener('click', () => load(false));
  document.querySelector('#git-history-close').addEventListener('click', () => dialog.close());

  return {
    setAvailable(available) { openButton.disabled = !available; },
    dispose() { diff.dispose(); original.dispose(); modified.dispose(); },
  };
}
