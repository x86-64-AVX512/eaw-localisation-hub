import { decodeBase64 } from './review-utilities.js';
import { createStandardDiffView } from './standard-diff-view.js';

export function createGitHistoryPanel({ monaco, state, token, showToast }) {
  const openButton = document.querySelector('#git-history-open');
  const dialog = document.querySelector('#git-history-dialog');
  const list = document.querySelector('#git-history-list');
  const empty = document.querySelector('#git-history-empty');
  const more = document.querySelector('#git-history-more');
  const selection = document.querySelector('#git-history-selection');
  const fromSelect = document.querySelector('#git-history-from');
  const toSelect = document.querySelector('#git-history-to');
  const diffView = createStandardDiffView({
    monaco, container: document.querySelector('#git-history-diff'),
  });
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
      item.innerHTML = '<strong class="history-subject"></strong><span class="history-author"></span><small></small>';
      item.querySelector('.history-subject').textContent = entry.subject;
      item.querySelector('.history-subject').title = entry.subject;
      item.querySelector('.history-author').textContent = `${entry.shortCommit} · ${entry.author}`;
      item.querySelector('.history-author').title = entry.author;
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
      diffView.clear();
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
    diffView.clear();
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
      diffView.setTexts(decodeBase64(payload.baseBase64), decodeBase64(payload.headBase64));
      selection.textContent = `${String(payload.fromCommit).slice(0, 10)} → ${String(payload.toCommit).slice(0, 10)}`;
    } catch (error) {
      if (requestId === comparisonId) selection.textContent = error.message;
      showToast(error.message, true);
    }
  }

  openButton.addEventListener('click', () => {
    dialog.showModal();
    diffView.layout();
    load(true);
  });
  fromSelect.addEventListener('change', compare);
  toSelect.addEventListener('change', compare);
  more.addEventListener('click', () => load(false));
  document.querySelector('#git-history-close').addEventListener('click', () => dialog.close());
  document.querySelector('#git-history-fullscreen').addEventListener('click', (event) => {
    dialog.classList.toggle('fullscreen');
    event.currentTarget.textContent = dialog.classList.contains('fullscreen') ? 'Обычный размер' : 'На весь экран';
    requestAnimationFrame(diffView.layout);
  });

  return {
    setAvailable(available) { openButton.disabled = !available; },
    dispose() { diffView.dispose(); },
  };
}
