import { byteToUtf16, safeColor, utf16ToByte } from './review-utilities.ts';
import { avatarElement } from './avatar-view.ts';
import { requiredElement } from './dom-elements.ts';
import type { CollaborationPanelOptions, ReviewExternalConflict } from './review-state.ts';

function listButton(title: string, subtitle: string, color: unknown, selected: boolean,
  action: () => void, avatarBase64 = ''): HTMLButtonElement {
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

function emptyList(container: HTMLElement, text: string): void {
  const empty = document.createElement('div');
  empty.className = 'empty-list';
  empty.textContent = text;
  container.append(empty);
}

export function createCollaborationPanel({
  state, editor, send, selectionBytes, jumpToBytes, showToast, openConflictDiff,
}: CollaborationPanelOptions) {
  const presenceList = requiredElement<HTMLElement>('#presence-list');
  const presenceCount = requiredElement<HTMLElement>('#presence-count');
  const reservationList = requiredElement<HTMLElement>('#reservation-list');
  const reservationCount = requiredElement<HTMLElement>('#reservation-count');
  const reservationTarget = requiredElement<HTMLSelectElement>('#reservation-target');
  const reservationComment = requiredElement<HTMLInputElement>('#reservation-comment');
  const conflictSection = requiredElement<HTMLElement>('.conflicts-section');
  const conflictList = requiredElement<HTMLElement>('#conflict-list');
  const conflictCount = requiredElement<HTMLElement>('#conflict-count');
  const deleteReservation = requiredElement<HTMLButtonElement>('#reservation-delete');
  const keepCollaborative = requiredElement<HTMLButtonElement>('#conflict-collaborative');
  const useExternal = requiredElement<HTMLButtonElement>('#conflict-external');
  const reservationNodes = new Map<string, { fingerprint: string; button: HTMLButtonElement }>();

  function jumpToConflict(conflict: ReviewExternalConflict): void {
    const model = editor.getModel();
    if (!conflict || conflict.key.startsWith('__')) {
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.revealLineInCenter(1);
    } else {
      const line = model?.getLinesContent().findIndex((value) => value.trimStart().startsWith(`${conflict.key}:`)) ?? -1;
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
        const model = editor.getModel();
        if (!model) throw new Error('Редактор ещё не открыл документ.');
        const position = model.getPositionAt(byteToUtf16(editor.getValue(), presence.positionByte));
        line = `строка ${position.lineNumber}`;
      } catch { /* A following presence update will supply positions for the new text. */ }
      presenceList.append(listButton(presence.user, line, presence.color, false, () => {
        try { jumpToBytes(presence.positionByte, presence.anchorByte); }
        catch { showToast('Позиция участника обновляется.', true); }
      }, presence.avatarBase64));
    }
    presenceCount.textContent = String(values.length + 1);
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
    const previousScrollTop = reservationList.scrollTop;
    const values = [...state.reservations.values()].sort((left, right) => left.startByte - right.startByte);
    const live = new Set<string>();
    const nodes: HTMLButtonElement[] = [];
    for (const item of values) {
      live.add(item.id);
      const details = [
        `${item.keyCount} ключ(а/ей)`, item.status === 'orphaned' ? 'границы потеряны' : item.status,
        item.createdBy && item.createdBy !== item.assignee ? `создал ${item.createdBy}` : '', item.comment,
      ].filter(Boolean).join(' · ');
      const fingerprint = JSON.stringify([
        item.assignee, details, item.color, state.selectedReservation === item.id,
        state.reservationTargets.find((target) => target.id === item.assigneeId)?.avatarBase64 ?? '',
      ]);
      let cached = reservationNodes.get(item.id);
      if (!cached || cached.fingerprint !== fingerprint) {
        const button = listButton(item.assignee, details, item.color,
          state.selectedReservation === item.id, () => {
          const current = state.reservations.get(item.id);
          if (!current) return;
          state.selectedReservation = item.id;
          deleteReservation.disabled = false;
          renderReservations();
          if (current.status !== 'orphaned') {
            try { jumpToBytes(current.startByte, current.endByte); }
            catch { showToast('Границы брони обновляются.', true); }
          }
        }, state.reservationTargets.find((target) => target.id === item.assigneeId)?.avatarBase64 ?? '');
        cached = { fingerprint, button };
        reservationNodes.set(item.id, cached);
      }
      nodes.push(cached.button);
    }
    for (const id of reservationNodes.keys()) if (!live.has(id)) reservationNodes.delete(id);
    if (!nodes.length) {
      if (!reservationList.firstElementChild?.classList.contains('empty-list')) {
        reservationList.replaceChildren(); emptyList(reservationList, 'Броней нет.');
      }
    } else {
      nodes.forEach((node, index) => {
        const current = reservationList.children[index] ?? null;
        if (current !== node) reservationList.insertBefore(node, current);
      });
      while (reservationList.children.length > nodes.length) reservationList.lastElementChild?.remove();
    }
    reservationList.scrollTop = previousScrollTop;
    reservationCount.textContent = String(values.length);
    if (!state.reservations.has(state.selectedReservation)) {
      state.selectedReservation = '';
      deleteReservation.disabled = true;
    }
  }

  function renderConflicts() {
    const previousScrollTop = conflictList.scrollTop;
    conflictList.replaceChildren();
    const values = [...state.externalConflicts.values()];
    conflictSection.hidden = values.length === 0;
    for (const item of values) {
      const identity = `${item.source || 'disk'}:${item.key}`;
      conflictList.append(listButton(item.label, item.detail ?? '', '#ff9b57', state.selectedConflict === identity, () => {
        state.selectedConflict = identity;
        keepCollaborative.disabled = false;
        useExternal.disabled = false;
        renderConflicts();
        jumpToConflict(item);
      openConflictDiff?.(item);
      }));
    }
    conflictCount.textContent = String(values.length);
    if (!state.externalConflicts.has(state.selectedConflict)) {
      state.selectedConflict = '';
      keepCollaborative.disabled = true;
      useExternal.disabled = true;
    }
    conflictList.scrollTop = previousScrollTop;
  }

  function refresh(sections: Set<string> | null = null): void {
    if (!sections || sections.has('presences')) renderPresences();
    if (!sections || sections.has('targets')) renderTargets();
    if (!sections || sections.has('reservations')) renderReservations();
    if (!sections || sections.has('conflicts')) renderConflicts();
  }

  requiredElement<HTMLButtonElement>('#reservation-create').addEventListener('click', () => {
    const range = selectionBytes();
    if (range.start === range.end) return showToast('Сначала выделите один или несколько ключей.', true);
    const target = state.reservationTargets[Number(reservationTarget.value)];
    if (!target) return showToast('Не удалось определить владельца брони.', true);
    send({
      type: 'reservationCreate', path: state.path, startByte: range.start, endByte: range.end,
      assigneeId: target.id, assignee: target.displayName, assigneeColor: target.color,
      comment: reservationComment.value.trim(),
    });
  });
  requiredElement<HTMLButtonElement>('#reservation-delete-at').addEventListener('click', () => {
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model) return;
    const offset = model.getOffsetAt(selection.getPosition());
    send({ type: 'reservationDeleteAt', path: state.path,
      positionByte: utf16ToByte(editor.getValue(), offset) });
  });
  deleteReservation.addEventListener('click', () => {
    if (state.selectedReservation) send({ type: 'reservationDelete', path: state.path, id: state.selectedReservation });
  });
  function resolveConflict(choice: 'collaborative' | 'external'): void {
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
