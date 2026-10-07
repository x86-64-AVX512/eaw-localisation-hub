import { uiText, uiMessage } from '../../../packages/shared/src/ui-language.mts';
import { byteToUtf16 } from './review-utilities.ts';
import { requiredElement } from './dom-elements.ts';
import { keysInsideRange } from '../../../packages/shared/src/localisation-keys.mts';
import type { CollaborationPanelOptions, CollaborationCommand, ReviewReservation, ReservationUpdateResult } from './review-state.ts';

type UpdateCommand = Extract<CollaborationCommand, { type: 'reservationUpdate' }>;

export function createReservationEditor({ state, editor, selectionBytes, send, showToast,
  canEditReservations = () => true, anchor = (message) => message }: CollaborationPanelOptions) {
  const panel = requiredElement('#reservation-editor');
  const title = requiredElement('#reservation-edit-title');
  const section = requiredElement('.reservations-section');
  const edit = requiredElement<HTMLButtonElement>('#reservation-edit');
  const target = requiredElement<HTMLSelectElement>('#reservation-edit-target');
  const comment = requiredElement<HTMLInputElement>('#reservation-edit-comment');
  const rangeLabel = requiredElement('#reservation-edit-range');
  const status = requiredElement('#reservation-edit-status');
  const useSelection = requiredElement<HTMLButtonElement>('#reservation-edit-selection');
  const resetRange = requiredElement<HTMLButtonElement>('#reservation-edit-reset-range');
  const save = requiredElement<HTMLButtonElement>('#reservation-edit-save');
  const cancel = requiredElement<HTMLButtonElement>('#reservation-edit-cancel');
  const reload = requiredElement<HTMLButtonElement>('#reservation-edit-reload');
  let original: ReviewReservation | null = null;
  let range: Pick<UpdateCommand, 'startByte' | 'endByte' | 'reviewAnchors'> | null = null;
  let pending = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let targetFingerprint = '';

  function renderTargets(value = target.value) {
    const fingerprint = JSON.stringify(state.reservationTargets);
    if (fingerprint === targetFingerprint) { target.value = value; return; }
    targetFingerprint = fingerprint;
    target.replaceChildren();
    // Keep an unavailable current assignee selectable only as "unchanged".
    const unchanged = document.createElement('option');
    unchanged.value = ''; unchanged.textContent = uiText('Оставить текущего исполнителя'); target.append(unchanged);
    for (const person of state.reservationTargets) {
      const option = document.createElement('option');
      option.value = person.id || person.displayName; option.textContent = person.displayName; target.append(option);
    }
    target.value = [...target.options].some((option) => option.value === value) ? value : '';
  }

  function refresh() {
    edit.disabled = Boolean(original) || !state.reservationUpdates || !canEditReservations()
      || !state.reservations.has(state.selectedReservation);
    edit.title = state.reservationUpdates ? '' : uiText('Этот сервер ещё не поддерживает изменение брони.');
    if (!original) return;
    renderTargets();
    const current = state.reservations.get(original.id);
    const stale = Boolean(current && (current.revision ?? 0) !== (original.revision ?? 0));
    if (!pending && !current) status.textContent = uiText('Бронь удалена другим участником. Введённые данные сохранены в форме.');
    else if (!pending && stale) status.textContent = uiText('Бронь уже изменена. Введённые данные сохранены; загрузите актуальную бронь перед повторным сохранением.');
    save.disabled = Boolean(pending) || !current || stale || !canEditReservations() || !state.reservationUpdates;
    target.disabled = comment.disabled = useSelection.disabled = Boolean(pending);
    resetRange.disabled = Boolean(pending) || !range;
    cancel.disabled = Boolean(pending);
    reload.hidden = !stale;
    reload.disabled = Boolean(pending) || !current;
    if (!range) rangeLabel.textContent = current?.status === 'orphaned'
      ? uiText('Границы потеряны. Можно задать новое выделение.')
      : uiText('Текущий диапазон: {0} ключ(а/ей). Границы сохраняются.', current?.keyCount ?? original.keyCount);
  }

  function open(item: ReviewReservation) {
    original = { ...item }; range = null;
    title.textContent = uiText('Изменение брони для {0}', item.assignee);
    renderTargets(item.assigneeId || '');
    comment.value = item.comment ?? '';
    status.textContent = ''; panel.hidden = false;
    section.classList.add('editing-reservation'); refresh(); comment.focus();
  }

  function close() {
    clearTimeout(timer); pending = ''; original = null; range = null;
    panel.hidden = true; section.classList.remove('editing-reservation'); refresh();
  }

  edit.addEventListener('click', () => {
    const item = state.reservations.get(state.selectedReservation);
    if (item && !edit.disabled) open(item);
  });
  cancel.addEventListener('click', () => { if (!pending) close(); });
  reload.addEventListener('click', () => {
    const item = original && state.reservations.get(original.id);
    if (item && !pending) open(item);
  });
  resetRange.addEventListener('click', () => { if (!pending) { range = null; refresh(); } });
  useSelection.addEventListener('click', () => {
    if (!original || pending) return;
    const selected = selectionBytes();
    const startByte = Math.min(selected.start, selected.end), endByte = Math.max(selected.start, selected.end);
    if (startByte === endByte) return showToast(uiText('Сначала выделите один или несколько ключей.'), true);
    const source = editor.getValue();
    const start = byteToUtf16(source, startByte), end = byteToUtf16(source, endByte);
    // The Agent and server count keys with this same shared reader.
    const keys = keysInsideRange(source, start, end);
    if (!keys.length || keys.length > 1000) return showToast(uiText('Выделение должно содержать от 1 до 1000 ключей локализации.'), true);
    const command = anchor({ type: 'reservationUpdate', path: state.path, id: original.id,
      requestId: '', expectedRevision: original.revision ?? 0, startByte, endByte });
    range = { startByte, endByte, ...command.reviewAnchors ? { reviewAnchors: command.reviewAnchors } : {} };
    rangeLabel.textContent = uiText('Новое выделение: {0} ключ(а/ей), строки {1}–{2}.', keys.length,
      source.slice(0, start).split('\n').length, source.slice(0, Math.max(start, end - 1)).split('\n').length);
    refresh();
  });
  save.addEventListener('click', () => {
    refresh();
    if (!original || save.disabled) return;
    const person = state.reservationTargets.find((item) => (item.id || item.displayName) === target.value);
    const command: UpdateCommand = { type: 'reservationUpdate', path: state.path, id: original.id,
      requestId: crypto.randomUUID(), expectedRevision: original.revision ?? 0, ...range };
    if (comment.value !== (original.comment ?? '')) command.comment = comment.value;
    if (target.value && !person) return showToast(uiText('Не удалось определить владельца брони.'), true);
    if (person && (person.id !== original.assigneeId || !person.id && person.displayName !== original.assignee)) {
      command.assigneeId = person.id; command.assignee = person.displayName; command.assigneeColor = person.color;
    }
    if (!range && command.comment === undefined && command.assigneeId === undefined) { close(); return; }
    if (new TextEncoder().encode(comment.value).length > 1024 || /[\u0000-\u001f\u007f]/u.test(comment.value)) {
      status.textContent = uiText('Примечание ограничено 1024 байтами UTF-8 и не должно содержать управляющих символов.'); return;
    }
    pending = command.requestId; status.textContent = uiText('Сохранение брони…'); refresh();
    timer = setTimeout(() => {
      pending = ''; status.textContent = uiText('Подтверждение не получено. Проверьте актуальную бронь перед повторной попыткой.'); refresh();
    }, 15000);
    send(command);
  });

  function receive(result: ReservationUpdateResult) {
    if (!original || result.id !== original.id || result.requestId !== pending) return;
    clearTimeout(timer); pending = '';
    if (result.status === 'saved') { close(); showToast(uiText('Бронь изменена.')); return; }
    status.textContent = result.message ? uiMessage(result.message) : result.status === 'deleted'
      ? uiText('Бронь удалена другим участником. Введённые данные сохранены в форме.')
      : uiText('Бронь уже изменена. Введённые данные сохранены; загрузите актуальную бронь перед повторным сохранением.');
    refresh();
  }
  return { refresh, receive, hasDraft: () => Boolean(original), dispose: () => clearTimeout(timer) };
}
