import { byteToUtf16, safeColor, utf16ToByte } from './review-utilities.js';
import { avatarElement } from './avatar-view.js';

function listButton(title, subtitle, color, selected, action, avatarBase64 = '') {
  const button = document.createElement('button');
  button.className = `list-item${selected ? ' selected' : ''}`;
  button.style.setProperty('--item-color', safeColor(color));
  const heading = document.createElement('span');
  heading.className = 'item-title';
  const avatar = avatarElement(title, color, avatarBase64, 'avatar-small');
  const text = document.createElement('span');
  text.textContent = title;
  heading.append(avatar, text);
  button.append(heading);
  if (subtitle) {
    const detail = document.createElement('small');
    detail.textContent = subtitle;
    button.append(detail);
  }
  button.addEventListener('click', action);
  return button;
}

function emptyList(container, text) {
  const empty = document.createElement('div');
  empty.className = 'empty-list';
  empty.textContent = text;
  container.append(empty);
}

export function createCollaborationPanel({
  state, editor, send, selectionBytes, jumpToBytes, showToast, openConflictDiff,
}) {
  const presenceList = document.querySelector('#presence-list');
  const reservationList = document.querySelector('#reservation-list');
  const reservationTarget = document.querySelector('#reservation-target');
  const conflictList = document.querySelector('#conflict-list');
  const deleteReservation = document.querySelector('#reservation-delete');
  const keepCollaborative = document.querySelector('#conflict-collaborative');
  const useExternal = document.querySelector('#conflict-external');

  function jumpToConflict(conflict) {
    const model = editor.getModel();
    if (!conflict || conflict.key.startsWith('__')) {
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.revealLineInCenter(1);
    } else {
      const line = model.getLinesContent().findIndex((value) => value.trimStart().startsWith(`${conflict.key}:`));
      if (line >= 0) {
        editor.setPosition({ lineNumber: line + 1, column: 1 });
        editor.revealLineInCenter(line + 1);
      }
    }
    editor.focus();
  }

  function renderPresences() {
    presenceList.replaceChildren();
    presenceList.append(listButton(`${state.user} (вы)`, 'Текущий Review-клиент', state.color,
      false, () => editor.focus(), state.avatarBase64));
    const values = [...state.presences.values()].sort((left, right) => left.user.localeCompare(right.user, 'ru'));
    for (const presence of values) {
      let line = 'позиция обновляется';
      try {
        const position = editor.getModel().getPositionAt(byteToUtf16(editor.getValue(), presence.positionByte));
        line = `строка ${position.lineNumber}`;
      } catch { /* A following presence update will supply positions for the new text. */ }
      presenceList.append(listButton(presence.user, line, presence.color, false, () => {
        try { jumpToBytes(presence.positionByte, presence.anchorByte); }
        catch { showToast('Позиция участника обновляется.', true); }
      }, presence.avatarBase64));
    }
    document.querySelector('#presence-count').textContent = String(values.length + 1);
  }

  function renderTargets() {
    const previous = reservationTarget.value;
    reservationTarget.replaceChildren();
    state.reservationTargets.forEach((target, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${target.displayName}${target.isSelf ? ' (вы)' : ''}`;
      reservationTarget.append(option);
    });
    if ([...reservationTarget.options].some((option) => option.value === previous)) reservationTarget.value = previous;
  }

  function renderReservations() {
    reservationList.replaceChildren();
    const values = [...state.reservations.values()].sort((left, right) => left.startByte - right.startByte);
    if (!values.length) emptyList(reservationList, 'Броней нет.');
    for (const item of values) {
      const details = [
        `${item.keyCount} ключ(а/ей)`, item.status === 'orphaned' ? 'границы потеряны' : item.status,
        item.createdBy && item.createdBy !== item.assignee ? `создал ${item.createdBy}` : '', item.comment,
      ].filter(Boolean).join(' · ');
      reservationList.append(listButton(item.assignee, details, item.color,
        state.selectedReservation === item.id, () => {
          state.selectedReservation = item.id;
          deleteReservation.disabled = false;
          renderReservations();
          if (item.status !== 'orphaned') {
            try { jumpToBytes(item.startByte, item.endByte); }
            catch { showToast('Границы брони обновляются.', true); }
          }
        }, state.reservationTargets.find((target) => target.id === item.assigneeId)?.avatarBase64 ?? ''));
    }
    document.querySelector('#reservation-count').textContent = String(values.length);
    if (!state.reservations.has(state.selectedReservation)) {
      state.selectedReservation = '';
      deleteReservation.disabled = true;
    }
  }

  function renderConflicts() {
    const previousScrollTop = conflictList.scrollTop;
    conflictList.replaceChildren();
    const values = [...state.externalConflicts.values()];
    if (!values.length) emptyList(conflictList, 'Конфликтов нет.');
    for (const item of values) {
      const identity = `${item.source || 'disk'}:${item.key}`;
      conflictList.append(listButton(item.label, item.detail, '#ff9b57', state.selectedConflict === identity, () => {
        state.selectedConflict = identity;
        keepCollaborative.disabled = false;
        useExternal.disabled = false;
        renderConflicts();
        jumpToConflict(item);
      openConflictDiff?.(item);
      }));
    }
    document.querySelector('#conflict-count').textContent = String(values.length);
    if (!state.externalConflicts.has(state.selectedConflict)) {
      state.selectedConflict = '';
      keepCollaborative.disabled = true;
      useExternal.disabled = true;
    }
    conflictList.scrollTop = previousScrollTop;
  }

  function refresh() {
    renderPresences();
    renderTargets();
    renderReservations();
    renderConflicts();
  }

  document.querySelector('#reservation-create').addEventListener('click', () => {
    const range = selectionBytes();
    if (range.start === range.end) return showToast('Сначала выделите один или несколько ключей.', true);
    const target = state.reservationTargets[Number(reservationTarget.value)];
    if (!target) return showToast('Не удалось определить владельца брони.', true);
    send({
      type: 'reservationCreate', path: state.path, startByte: range.start, endByte: range.end,
      assigneeId: target.id, assignee: target.displayName, assigneeColor: target.color,
      comment: document.querySelector('#reservation-comment').value.trim(),
    });
  });
  document.querySelector('#reservation-delete-at').addEventListener('click', () => {
    const selection = editor.getSelection();
    const offset = editor.getModel().getOffsetAt(selection.getPosition());
    send({ type: 'reservationDeleteAt', path: state.path,
      positionByte: utf16ToByte(editor.getValue(), offset) });
  });
  deleteReservation.addEventListener('click', () => {
    if (state.selectedReservation) send({ type: 'reservationDelete', path: state.path, id: state.selectedReservation });
  });
  function resolveConflict(choice) {
    const conflict = state.externalConflicts.get(state.selectedConflict);
    if (conflict) send({
      type: 'externalConflictResolve', path: state.path,
      key: conflict.key, source: conflict.source || 'disk', choice,
    });
  }
  keepCollaborative.addEventListener('click', () => resolveConflict('collaborative'));
  useExternal.addEventListener('click', () => resolveConflict('external'));

  return { refresh };
}
