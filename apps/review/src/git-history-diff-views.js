import { createStandardDiffView } from './standard-diff-view.js';

const MAX_CACHED_PAIRS = 3;
const MAX_CACHED_CHARACTERS = 1_200_000;

export function createGitHistoryDiffViews({ monaco, container }) {
  container.classList.add('git-history-diff-host');
  const status = document.createElement('div');
  status.className = 'git-history-diff-status';
  status.textContent = 'Загрузка сравнения…';
  status.hidden = true;
  container.append(status);
  const cached = new Map();
  let activePair = '';
  let pending = null;
  let visible = false;

  function removeEntry(entry) {
    entry.listener?.dispose();
    entry.view.dispose();
    entry.element.remove();
  }

  function cancelPending() {
    if (!pending) return;
    removeEntry(pending);
    pending = null;
  }

  function activate(entry) {
    activePair = entry.pair;
    for (const candidate of cached.values()) {
      const selected = candidate === entry;
      candidate.element.classList.toggle('active', selected);
      candidate.element.inert = !selected;
      candidate.view.setActive(selected && visible);
    }
    status.hidden = true;
  }

  function prune() {
    let characters = [...cached.values()].reduce((sum, entry) => sum + entry.characters, 0);
    for (const [pair, entry] of cached) {
      if (cached.size <= MAX_CACHED_PAIRS && characters <= MAX_CACHED_CHARACTERS) break;
      if (pair === activePair) continue;
      cached.delete(pair);
      characters -= entry.characters;
      removeEntry(entry);
    }
  }

  function showCached(pair) {
    const entry = cached.get(pair);
    if (!entry) return false;
    cancelPending();
    cached.delete(pair);
    cached.set(pair, entry);
    activate(entry);
    return true;
  }

  function showLoading() {
    cancelPending();
    status.textContent = 'Вычисление отличий…';
    status.hidden = false;
  }

  function prepare(pair, original, modified, onReady) {
    cancelPending();
    const element = document.createElement('div');
    element.className = 'git-history-diff-page';
    element.inert = true;
    container.append(element);
    let view;
    try {
      view = createStandardDiffView({
        monaco, container: element, preserveOnDeactivate: true,
        editorOptions: { maxComputationTime: 500, ignoreTrimWhitespace: false },
      });
    } catch (error) {
      element.remove();
      throw error;
    }
    view.setActive(false);
    const entry = { pair, element, view, characters: original.length + modified.length, listener: null };
    pending = entry;
    entry.listener = view.diff.onDidUpdateDiff(() => {
      const changes = view.diff.getLineChanges();
      if (pending !== entry || !changes || (original !== modified && !changes.length)) return;
      entry.listener.dispose();
      entry.listener = null;
      pending = null;
      cached.set(pair, entry);
      activate(entry);
      prune();
      onReady();
    });
    try {
      view.setTexts(original, modified);
    } catch (error) {
      cancelPending();
      throw error;
    }
  }

  return {
    showCached, showLoading, prepare,
    clear() {
      cancelPending();
      for (const entry of cached.values()) removeEntry(entry);
      cached.clear();
      activePair = '';
      status.hidden = true;
    },
    suspend() {
      visible = false;
      cancelPending();
      status.hidden = true;
      for (const entry of cached.values()) entry.view.setActive(false);
    },
    resume() {
      visible = true;
      const entry = cached.get(activePair);
      if (entry) entry.view.setActive(true);
    },
    layout() { cached.get(activePair)?.view.layout(); },
    dispose() {
      this.clear();
      status.remove();
    },
  };
}
