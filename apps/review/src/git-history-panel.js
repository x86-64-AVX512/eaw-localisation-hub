import { decodeBase64 } from './review-utilities.js';
import { createGitHistoryDiffViews } from './git-history-diff-views.js';

export function createGitHistoryPanel({ monaco, state, token, showToast }) {
  const openButton = document.querySelector('#git-history-open');
  const dialog = document.querySelector('#git-history-dialog');
  dialog.inert = !dialog.open;
  const list = document.querySelector('#git-history-list');
  const empty = document.querySelector('#git-history-empty');
  const more = document.querySelector('#git-history-more');
  const selection = document.querySelector('#git-history-selection');
  const fromSelect = document.querySelector('#git-history-from');
  const toSelect = document.querySelector('#git-history-to');
  const diffViews = createGitHistoryDiffViews({
    monaco, container: document.querySelector('#git-history-diff'),
  });
  let entries = [];
  let nextOffset = 0;
  let hasMore = false;
  let loading = false;
  let comparisonId = 0;
  let loadId = 0;
  let headCheckId = 0;
  let loadedPath = '';
  let loadedHead = '';
  let shownPair = '';
  let pendingPair = '';
  let savedSelection = '';
  let cacheCleared = false;
  const onCacheCleared = () => { cacheCleared = true; };
  window.addEventListener('eaw-diff-cache-cleared', onCacheCleared);

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
    if (loading || !state.path || !dialog.open) return;
    loading = true;
    const requestedPath = state.path;
    const generation = ++loadId;
    let reload = false;
    if (reset) {
      comparisonId += 1;
      headCheckId += 1;
      entries = [];
      nextOffset = 0;
      hasMore = false;
      loadedPath = '';
      loadedHead = '';
      shownPair = '';
      pendingPair = '';
      diffViews.clear();
      selection.textContent = 'Загрузка истории Git…';
    }
    render();
    try {
      const query = new URLSearchParams({ path: requestedPath, offset: String(nextOffset), limit: '50' });
      const payload = await request(`/api/git-history?${query}`);
      if (generation !== loadId || !dialog.open || state.path !== requestedPath) return;
      if (!/^[0-9a-f]{40,64}$/iu.test(payload.headCommit ?? '')) {
        throw new Error('Agent не сообщил текущий Git HEAD. Обновите Desktop Agent.');
      }
      if (!reset && payload.headCommit !== loadedHead) { reload = true; return; }
      loadedPath = requestedPath;
      loadedHead = payload.headCommit;
      entries.push(...(payload.entries ?? []).filter(
        (entry) => !entries.some((known) => known.commit === entry.commit),
      ));
      nextOffset = payload.nextOffset ?? entries.length;
      hasMore = payload.hasMore === true;
      updateSelectors();
      if (entries.length) await compare();
      else {
        savedSelection = 'История файла пуста';
        selection.textContent = savedSelection;
      }
    } catch (error) {
      if (generation === loadId && dialog.open && state.path === requestedPath) {
        selection.textContent = error.message;
        showToast(error.message, true);
      }
    } finally {
      if (generation === loadId) {
        loading = false;
        render();
        if (reload && dialog.open) load(true);
      }
    }
  }

  async function compare() {
    if (!dialog.open || loadedPath !== state.path || !loadedHead) return;
    const from = fromSelect.value;
    const to = toSelect.value;
    if (!from || !to) return;
    const fromEntry = entryFor(from);
    const toEntry = entryFor(to);
    const requestedPath = state.path;
    const headAtRequest = loadedHead;
    const selectedFrom = from === 'HEAD' ? headAtRequest : from;
    const selectedTo = to === 'HEAD' ? headAtRequest : to;
    const pair = JSON.stringify([
      requestedPath, headAtRequest, selectedFrom, fromEntry?.historicalPath ?? state.relativePath,
      selectedTo, toEntry?.historicalPath ?? state.relativePath,
    ]);
    if (shownPair === pair || pendingPair === pair) return;
    const requestId = ++comparisonId;
    pendingPair = pair;
    const pairLabel = `${shortLabel(from)} → ${shortLabel(to)}`;
    if (diffViews.showCached(pair)) {
      pendingPair = '';
      shownPair = pair;
      savedSelection = pairLabel;
      selection.textContent = pairLabel;
      render();
      return;
    }
    selection.textContent = `${pairLabel} · загрузка…`;
    shownPair = '';
    diffViews.showLoading();
    render();
    try {
      const query = new URLSearchParams({
        path: requestedPath,
        from: selectedFrom,
        to: selectedTo,
        fromPath: fromEntry?.historicalPath ?? state.relativePath,
        toPath: toEntry?.historicalPath ?? state.relativePath,
      });
      const payload = await request(`/api/git-history/diff?${query}`);
      if (requestId !== comparisonId || !dialog.open || state.path !== requestedPath
        || loadedHead !== headAtRequest) return;
      selection.textContent = `${pairLabel} · вычисление отличий…`;
      diffViews.prepare(pair, decodeBase64(payload.baseBase64), decodeBase64(payload.headBase64), () => {
        if (requestId !== comparisonId || !dialog.open || state.path !== requestedPath
          || loadedHead !== headAtRequest) return;
        shownPair = pair;
        pendingPair = '';
        savedSelection = `${String(payload.fromCommit).slice(0, 10)} → ${String(payload.toCommit).slice(0, 10)}`;
        selection.textContent = savedSelection;
      });
    } catch (error) {
      if (requestId === comparisonId && dialog.open && state.path === requestedPath
        && loadedHead === headAtRequest) {
        pendingPair = '';
        selection.textContent = error.message;
        showToast(error.message, true);
      }
    }
  }

  async function verifyCachedHead() {
    const requestedPath = state.path;
    const generation = ++headCheckId;
    const comparisonAtStart = comparisonId;
    selection.textContent = `${savedSelection} · проверка Git…`;
    try {
      const query = new URLSearchParams({ path: requestedPath });
      const { headCommit } = await request(`/api/git-history/head?${query}`);
      if (generation !== headCheckId || !dialog.open || state.path !== requestedPath) return;
      if (headCommit !== loadedHead) { load(true); return; }
      if (comparisonId === comparisonAtStart) selection.textContent = savedSelection;
      if (!shownPair && entries.length) compare();
    } catch (error) {
      if (generation !== headCheckId || !dialog.open || state.path !== requestedPath) return;
      selection.textContent = `${savedSelection} · актуальность Git не проверена`;
      showToast(error.message, true);
    }
  }

  openButton.addEventListener('click', () => {
    dialog.inert = false;
    dialog.showModal();
    diffViews.resume();
    if (!cacheCleared && loadedPath === state.path && loadedHead) {
      verifyCachedHead();
    } else {
      cacheCleared = false;
      load(true);
    }
  });
  fromSelect.addEventListener('change', compare);
  toSelect.addEventListener('change', compare);
  more.addEventListener('click', () => load(false));
  function suspend() {
    if (dialog.inert) return;
    dialog.inert = true;
    comparisonId += 1;
    pendingPair = '';
    loadId += 1;
    headCheckId += 1;
    loading = false;
    diffViews.suspend();
  }
  dialog.addEventListener('cancel', suspend);
  dialog.addEventListener('close', suspend);
  document.querySelector('#git-history-close').addEventListener('click', () => {
    suspend();
    dialog.close();
  });
  const onResize = () => { if (dialog.open) diffViews.layout(); };
  window.addEventListener('resize', onResize);
  document.querySelector('#git-history-fullscreen').addEventListener('click', (event) => {
    dialog.classList.toggle('fullscreen');
    event.currentTarget.textContent = dialog.classList.contains('fullscreen') ? 'Обычный размер' : 'На весь экран';
    requestAnimationFrame(diffViews.layout);
  });

  return {
    setAvailable(available) { openButton.disabled = !available; },
    dispose() {
      window.removeEventListener('eaw-diff-cache-cleared', onCacheCleared);
      window.removeEventListener('resize', onResize);
      diffViews.dispose();
    },
  };
}
