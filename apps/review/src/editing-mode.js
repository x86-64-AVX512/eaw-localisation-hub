import { byteToUtf16, decodeBase64, encodeBase64, utf16ToByte } from './review-utilities.js';
import { createSuggestionHistory } from './suggestion-history.js';
import {
  createSuggestionTrace, suggestionTraceOrigins,
} from '../../../packages/shared/src/suggestion-trace.mjs';

const SNAPSHOT_DELAY_MILLISECONDS = 120;

function codePointBefore(text, index) {
  if (index <= 0) return '';
  const point = text.codePointAt(text.charCodeAt(index - 1) >= 0xDC00
    && text.charCodeAt(index - 1) <= 0xDFFF ? index - 2 : index - 1);
  return point === undefined ? '' : String.fromCodePoint(point);
}

function codePointAt(text, index) {
  const point = text.codePointAt(index);
  return point === undefined ? '' : String.fromCodePoint(point);
}

function isWordPoint(value) {
  return /^[\p{L}\p{N}_]$/u.test(value);
}

export function isLineBreakBoundary(text, start, end = start) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end > text.length) return false;
  const boundary = (offset) => !(isWordPoint(codePointBefore(text, offset))
    && isWordPoint(codePointAt(text, offset)));
  return boundary(start) && boundary(end);
}

export function singleReplacement(previous, next) {
  if (previous === next) return null;
  const previousPoints = [...previous];
  const nextPoints = [...next];
  let sharedStart = 0;
  while (sharedStart < previousPoints.length && sharedStart < nextPoints.length
      && previousPoints[sharedStart] === nextPoints[sharedStart]) sharedStart += 1;
  let previousPointEnd = previousPoints.length;
  let nextPointEnd = nextPoints.length;
  while (previousPointEnd > sharedStart && nextPointEnd > sharedStart
      && previousPoints[previousPointEnd - 1] === nextPoints[nextPointEnd - 1]) {
    previousPointEnd -= 1;
    nextPointEnd -= 1;
  }
  const start = previousPoints.slice(0, sharedStart).join('').length;
  const previousEnd = previousPoints.slice(0, previousPointEnd).join('').length;
  const nextStart = nextPoints.slice(0, sharedStart).join('').length;
  const nextEnd = nextPoints.slice(0, nextPointEnd).join('').length;
  return { start, previousEnd, replacement: next.slice(nextStart, nextEnd) };
}

export function replacementFromOrigins(previous, next, origins) {
  if (!Array.isArray(origins) || origins.length !== next.length) return singleReplacement(previous, next);
  let start = 0;
  while (start < next.length && start < previous.length
    && origins[start] === start && next[start] === previous[start]) start += 1;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && nextEnd > start
    && origins[nextEnd - 1] === previousEnd - 1
    && next[nextEnd - 1] === previous[previousEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  if (start === previousEnd && start === nextEnd) return null;
  return { start, previousEnd, replacement: next.slice(start, nextEnd) };
}

export function suggestionAction(draftBase, current, suggestionId, updating = false, origins = null) {
  const hasOrigins = Array.isArray(origins) && origins.length === current.length;
  const replacement = hasOrigins
    ? replacementFromOrigins(draftBase, current, origins)
    : singleReplacement(draftBase, current);
  if (!replacement) return null;
  const action = {
    type: updating ? 'suggestionUpdate' : 'suggestionCreate',
    startByte: utf16ToByte(draftBase, replacement.start),
    endByte: utf16ToByte(draftBase, replacement.previousEnd),
    suggestionId,
    replacementBase64: encodeBase64(replacement.replacement),
  };
  if (hasOrigins) {
    action.traceJson = createSuggestionTrace(
      draftBase.slice(replacement.start, replacement.previousEnd),
      replacement.replacement,
      origins.slice(replacement.start, replacement.start + replacement.replacement.length),
      replacement.start,
    );
  }
  return action;
}

export function suggestionProjection(baseText, projectedText, origins = null) {
  const hasOrigins = Array.isArray(origins) && origins.length === projectedText.length;
  const replacement = hasOrigins
    ? replacementFromOrigins(baseText, projectedText, origins)
    : singleReplacement(baseText, projectedText);
  if (!replacement) return null;
  const projection = {
    baseText,
    start: replacement.start,
    previousEnd: replacement.previousEnd,
    replacementLength: replacement.replacement.length,
  };
  if (hasOrigins) projection.traceJson = createSuggestionTrace(
      baseText.slice(replacement.start, replacement.previousEnd),
      replacement.replacement,
      origins.slice(replacement.start, replacement.start + replacement.replacement.length),
      replacement.start,
    );
  return projection;
}

export function batchSuggestionActions(baseText, changes, idFactory = () => crypto.randomUUID()) {
  if (!Array.isArray(changes) || changes.length < 2) return [];
  const ordered = [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset);
  let previousEnd = -1;
  const result = [];
  for (const change of ordered) {
    const start = Number(change.rangeOffset);
    const end = start + Number(change.rangeLength);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd
      || start < 0 || end > baseText.length) return [];
    previousEnd = end;
    if (baseText.slice(start, end) === String(change.text)) continue;
    const replacement = String(change.text);
    result.push({
      type: 'suggestionCreate', suggestionId: idFactory(),
      startByte: utf16ToByte(baseText, start), endByte: utf16ToByte(baseText, end),
      replacementBase64: encodeBase64(replacement),
      traceJson: createSuggestionTrace(
        baseText.slice(start, end), replacement,
        Array.from({ length: replacement.length }, () => -1), start,
      ),
    });
  }
  return result;
}

export function baseToProjectedOffset(projection, offset, affinity = 'before') {
  if (!projection) return offset;
  const { start, previousEnd, replacementLength } = projection;
  if (offset < start) return offset;
  if (offset > previousEnd) return offset + replacementLength - (previousEnd - start);
  if (offset === previousEnd && previousEnd > start) return start + replacementLength;
  return affinity === 'after' ? start + replacementLength : start;
}

export function projectedToBaseOffset(projection, offset) {
  if (!projection) return offset;
  const { start, previousEnd, replacementLength } = projection;
  if (offset <= start) return offset;
  if (offset >= start + replacementLength) return offset - replacementLength + (previousEnd - start);
  return start;
}

function projectedEditingBounds(projection) {
  const { baseText, start, previousEnd, replacementLength } = projection;
  if (previousEnd <= start) return { start, end: start + replacementLength };

  let wordStart = start;
  let wordEnd = previousEnd;
  while (wordStart > 0 && isWordPoint(codePointBefore(baseText, wordStart))) {
    wordStart -= codePointBefore(baseText, wordStart).length;
  }
  while (wordEnd < baseText.length && isWordPoint(codePointAt(baseText, wordEnd))) {
    wordEnd += codePointAt(baseText, wordEnd).length;
  }
  return {
    start: baseToProjectedOffset(projection, wordStart),
    end: baseToProjectedOffset(projection, wordEnd, 'after'),
  };
}

export function createEditingModeController({
  state, editor, send, showToast, onDraftStateChange = () => {},
}) {
  const editButton = document.querySelector('#mode-edit');
  const suggestButton = document.querySelector('#mode-suggest');
  let mode = 'edit';
  let snapshotTimer;
  let draftBase = editor.getValue();
  let draftOrigins = Array.from({ length: draftBase.length }, (_, index) => index);
  const originVersions = new Map();
  let activeSuggestion = null;
  const suggestionHistory = createSuggestionHistory(send);
  let localRedoAvailable = false;
  const acceptedUndo = [];
  const acceptedRedo = [];

  function rememberDraftOrigins() {
    const version = editor.getModel().getAlternativeVersionId?.();
    if (!Number.isSafeInteger(version)) return;
    originVersions.set(version, [...draftOrigins]);
    if (originVersions.size > 512) originVersions.delete(originVersions.keys().next().value);
  }

  function resetDraftOrigins(text = draftBase) {
    draftOrigins = Array.from({ length: text.length }, (_, index) => index);
    rememberDraftOrigins();
  }

  rememberDraftOrigins();

  function recordAccepted(id) {
    acceptedUndo.push(id);
    acceptedRedo.length = 0;
  }

  function sendSnapshot() {
    clearTimeout(snapshotTimer);
    snapshotTimer = undefined;
    if (!state.ready || mode !== 'edit') return;
    send({ type: 'snapshot', path: state.path, textBase64: encodeBase64(editor.getValue()) });
  }

  function updateProjection() {
    const projection = suggestionProjection(draftBase, editor.getValue(), draftOrigins);
    state.suggestionProjection = projection ? {
      ...projection,
      color: activeSuggestion?.color ?? state.color,
      author: state.user,
    } : null;
  }

  function restoreDraftBase(projectedCaretIndex) {
    const caretIndex = projectedToBaseOffset(state.suggestionProjection, projectedCaretIndex);
    state.suggestionProjection = null;
    state.applyingRemote = true;
    editor.setValue(draftBase);
    editor.setPosition(editor.getModel().getPositionAt(Math.min(caretIndex, draftBase.length)));
    resetDraftOrigins();
    state.applyingRemote = false;
  }

  function syncSuggestion() {
    if (!state.ready || mode !== 'suggest') return false;
    const current = editor.getValue();
    if (activeSuggestion?.projectedText === current) return true;
    const id = activeSuggestion?.suggestionId ?? crypto.randomUUID();
    const action = suggestionAction(draftBase, current, id, Boolean(activeSuggestion), draftOrigins);
    if (!action) {
      if (activeSuggestion) {
        send({ type: 'suggestionDelete', path: state.path, id: activeSuggestion.suggestionId });
        activeSuggestion = null;
        state.editingSuggestionId = '';
        state.suggestionProjection = null;
        onDraftStateChange();
      }
      return false;
    }
    const outbound = { ...action, path: state.path };
    activeSuggestion = { ...outbound, color: state.color, projectedText: current };
    state.editingSuggestionId = id;
    updateProjection();
    localRedoAvailable = false;
    send(outbound);
    onDraftStateChange();
    return true;
  }

  function flushSuggestion(projectedCaretIndex = editor.getModel().getOffsetAt(editor.getPosition())) {
    if (!state.ready || mode !== 'suggest') return false;
    if (!activeSuggestion && !syncSuggestion()) return false;
    const action = activeSuggestion;
    restoreDraftBase(projectedCaretIndex);
    if (action.dirty !== false) suggestionHistory.record({
      type: 'suggestionCreate', path: action.path,
      startByte: action.startByte, endByte: action.endByte,
      suggestionId: action.suggestionId, replacementBase64: action.replacementBase64,
      traceJson: action.traceJson ?? '',
    });
    activeSuggestion = null;
    state.editingSuggestionId = '';
    localRedoAvailable = false;
    onDraftStateChange();
    return true;
  }

  function renderMode() {
    const suggesting = mode === 'suggest';
    editButton.classList.toggle('active', !suggesting);
    suggestButton.classList.toggle('active', suggesting);
    editButton.setAttribute('aria-pressed', String(!suggesting));
    suggestButton.setAttribute('aria-pressed', String(suggesting));
  }

  function setMode(nextMode) {
    if (nextMode === mode) return;
    if (mode === 'edit') sendSnapshot();
    else flushSuggestion();
    mode = nextMode;
    draftBase = editor.getValue();
    resetDraftOrigins();
    renderMode();
    showToast(mode === 'suggest'
      ? 'Режим правок: изменения создают предложения и не меняют документ напрямую.'
      : 'Обычный режим редактирования.');
    editor.focus();
  }

  function editSuggestion(item) {
    if (!item || item.status !== 'open') return false;
    const ownSuggestion = item.authorId
      ? item.authorId === state.userId
      : item.author === state.user;
    if (!ownSuggestion) return false;
    if (mode === 'suggest' && activeSuggestion?.suggestionId === item.id) {
      editor.focus();
      return true;
    }
    if (mode === 'suggest') flushSuggestion();
    else setMode('suggest');

    const model = editor.getModel();
    const baseText = model.getValue();
    let start;
    let end;
    try {
      start = byteToUtf16(baseText, Number(item.startByte));
      end = byteToUtf16(baseText, Number(item.endByte));
    } catch {
      showToast('\u041f\u0440\u0430\u0432\u043a\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043b\u0430: \u0435\u0451 \u043f\u043e\u0437\u0438\u0446\u0438\u044f \u0431\u043e\u043b\u044c\u0448\u0435 \u043d\u0435 \u0441\u043e\u0432\u043f\u0430\u0434\u0430\u0435\u0442 \u0441 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u043e\u043c.', true);
      return false;
    }
    const original = decodeBase64(item.originalBase64);
    if (baseText.slice(start, end) !== original) {
      showToast('\u041f\u0440\u0430\u0432\u043a\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043b\u0430: \u0438\u0441\u0445\u043e\u0434\u043d\u044b\u0439 \u0442\u0435\u043a\u0441\u0442 \u0443\u0436\u0435 \u0438\u0437\u043c\u0435\u043d\u0438\u043b\u0441\u044f.', true);
      return false;
    }

    draftBase = baseText;
    const replacement = decodeBase64(item.replacementBase64);
    const replacementOrigins = suggestionTraceOrigins(
      original, replacement, item.traceJson ?? '', start,
    );
    state.applyingRemote = true;
    model.pushEditOperations([], [{
      range: {
        startLineNumber: model.getPositionAt(start).lineNumber,
        startColumn: model.getPositionAt(start).column,
        endLineNumber: model.getPositionAt(end).lineNumber,
        endColumn: model.getPositionAt(end).column,
      },
      text: replacement,
    }], () => null);
    activeSuggestion = {
      type: 'suggestionUpdate', path: state.path,
      startByte: item.startByte, endByte: item.endByte,
      suggestionId: item.id, replacementBase64: item.replacementBase64,
      color: item.color ?? state.color, dirty: false, projectedText: model.getValue(),
      traceJson: item.traceJson ?? '',
    };
    draftOrigins = [
      ...Array.from({ length: start }, (_, index) => index),
      ...replacementOrigins,
      ...Array.from({ length: baseText.length - end }, (_, index) => end + index),
    ];
    rememberDraftOrigins();
    state.editingSuggestionId = item.id;
    updateProjection();
    editor.setPosition(model.getPositionAt(start + replacement.length));
    state.applyingRemote = false;
    onDraftStateChange();
    showToast('\u041f\u0440\u0430\u0432\u043a\u0430 \u043e\u0442\u043a\u0440\u044b\u0442\u0430 \u0434\u043b\u044f \u0440\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u044f.');
    editor.focus();
    return true;
  }

  const contentSubscription = editor.onDidChangeModelContent((event) => {
    if (!state.ready || state.applyingRemote) return;
    acceptedUndo.length = 0;
    acceptedRedo.length = 0;
    if (mode === 'edit') {
      clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(sendSnapshot, SNAPSHOT_DELAY_MILLISECONDS);
    } else {
      const changes = Array.isArray(event?.changes) ? [...event.changes] : [];
      const version = editor.getModel().getAlternativeVersionId?.();
      const historicalOrigins = (event?.isUndoing || event?.isRedoing)
        && Number.isSafeInteger(version) ? originVersions.get(version) : null;
      if (historicalOrigins?.length === editor.getValue().length) {
        draftOrigins = [...historicalOrigins];
      } else if ((event?.isUndoing || event?.isRedoing) && editor.getValue() === draftBase) {
        resetDraftOrigins();
      } else {
        for (const change of changes.sort((left, right) => right.rangeOffset - left.rangeOffset)) {
          const start = Number(change.rangeOffset);
          const removed = Number(change.rangeLength);
          const inserted = String(change.text ?? '');
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(removed)
            || start < 0 || removed < 0 || start + removed > draftOrigins.length) {
            draftOrigins = Array.from({ length: editor.getValue().length }, () => -1);
            break;
          }
          draftOrigins.splice(start, removed, ...Array.from({ length: inserted.length }, () => -1));
        }
        rememberDraftOrigins();
      }
      const actions = !activeSuggestion ? batchSuggestionActions(draftBase, event?.changes) : [];
      if (actions.length > 1) {
        const caret = editor.getModel().getOffsetAt(editor.getPosition());
        for (const action of actions) {
          const outbound = { ...action, path: state.path };
          send(outbound);
          suggestionHistory.record(outbound);
        }
        state.applyingRemote = true;
        editor.setValue(draftBase);
        editor.setPosition(editor.getModel().getPositionAt(Math.min(caret, draftBase.length)));
        resetDraftOrigins();
        state.applyingRemote = false;
        localRedoAvailable = false;
        onDraftStateChange();
        showToast(`Создано правок: ${actions.length}.`);
        return;
      }
      if (editor.getValue() !== draftBase) localRedoAvailable = false;
      syncSuggestion();
    }
  });

  const cursorSubscription = editor.onDidChangeCursorSelection((event) => {
    if (state.applyingRemote || mode !== 'suggest' || !activeSuggestion || !state.suggestionProjection) return;
    // Monaco may publish the caret move caused by typing before its content-change
    // notification. Synchronise the changed draft first so the old projection does
    // not mistake the newly extended replacement for a move outside the suggestion.
    if (editor.getValue() !== activeSuggestion.projectedText) syncSuggestion();
    if (!activeSuggestion || !state.suggestionProjection) return;
    const position = editor.getModel().getOffsetAt(event.selection.getPosition());
    const bounds = projectedEditingBounds(state.suggestionProjection);
    if (position < bounds.start || position > bounds.end) flushSuggestion(position);
  });

  editButton.addEventListener('click', () => setMode('edit'));
  suggestButton.addEventListener('click', () => setMode('suggest'));
  renderMode();

  return {
    isSuggesting: () => mode === 'suggest',
    editSuggestion,
    flushSuggestion,
    insertLineBreak() {
      const model = editor.getModel();
      const selection = editor.getSelection();
      const start = model.getOffsetAt(selection.getStartPosition());
      const end = model.getOffsetAt(selection.getEndPosition());
      if (!isLineBreakBoundary(model.getValue(), start, end)) {
        showToast('Перенос строки разрешён только перед словом или после него.', true);
        return false;
      }
      if (mode === 'suggest' && activeSuggestion && state.suggestionProjection) {
        // A line break moves the complete edited word. Do not let provenance-based
        // diffing peel matching letters back out into a second, newline-only draft.
        const bounds = projectedEditingBounds(state.suggestionProjection);
        for (let index = bounds.start; index < bounds.end; index += 1) draftOrigins[index] = -1;
        rememberDraftOrigins();
      }
      editor.pushUndoStop?.();
      editor.executeEdits('eaw-review-line-break', [{ range: selection, text: '\n' }]);
      editor.pushUndoStop?.();
      return true;
    },
    acceptSuggestion(item) {
      if (!item?.id) return;
      send({ type: 'suggestionAccept', path: state.path, id: item.id });
      recordAccepted(item.id);
    },
    revertSuggestion(item) {
      if (!item?.id) return;
      send({ type: 'suggestionRevert', path: state.path, id: item.id });
      const index = acceptedUndo.lastIndexOf(item.id);
      if (index >= 0) acceptedUndo.splice(index, 1);
      acceptedRedo.push(item.id);
    },
    beforeRemoteChange() { if (mode === 'suggest') flushSuggestion(); },
    afterRemoteChange() {
      if (mode === 'suggest') {
        activeSuggestion = null;
        state.editingSuggestionId = '';
        draftBase = editor.getValue();
        resetDraftOrigins();
        suggestionHistory.clear();
        localRedoAvailable = false;
      }
    },
    undo() {
      if (acceptedUndo.length) {
        const id = acceptedUndo.pop();
        acceptedRedo.push(id);
        send({ type: 'suggestionRevert', path: state.path, id });
        showToast('Принятие правки отменено.');
        return;
      }
      if (mode !== 'suggest') {
        send({ type: 'undo', path: state.path });
        return;
      }
      if (editor.getValue() !== draftBase) {
        editor.trigger('eaw-review', 'undo', null);
        localRedoAvailable = true;
        return;
      }
      if (suggestionHistory.undo(state.path)) {
        showToast('Последняя предложенная правка отменена.');
      }
    },
    redo() {
      if (acceptedRedo.length) {
        const id = acceptedRedo.pop();
        acceptedUndo.push(id);
        send({ type: 'suggestionAccept', path: state.path, id });
        showToast('Правка принята повторно.');
        return;
      }
      if (mode !== 'suggest') {
        send({ type: 'redo', path: state.path });
        return;
      }
      if (localRedoAvailable) {
        const before = editor.getValue();
        editor.trigger('eaw-review', 'redo', null);
        if (editor.getValue() !== before) {
          localRedoAvailable = true;
          return;
        }
        localRedoAvailable = false;
      }
      if (suggestionHistory.redo()) {
        showToast('Предложенная правка восстановлена.');
      }
    },
    dispose() {
      clearTimeout(snapshotTimer);
      contentSubscription.dispose();
      cursorSubscription.dispose();
    },
  };
}
