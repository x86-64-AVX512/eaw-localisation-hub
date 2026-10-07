import { controlledString } from './protocol-limits.mts';
import { resolveReservationRange } from './reservation-anchors.mjs';
import { keysInsideRange } from '../../../packages/shared/src/text.mts';

export function updateReservation(room, socket, message) {
  const id = controlledString(message.id, 'Reservation id', 128, { required: true });
  if (!Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0) {
    throw new Error('Invalid reservation revision');
  }
  const index = room.reservations.findIndex((item) => item.id === id);
  if (index < 0) { room.broadcastReservations(); return { status: 'deleted' }; }
  const previous = room.reservations[index];
  const revision = previous.revision ?? 0;
  if (message.expectedRevision !== revision) {
    room.broadcastReservations();
    return { status: 'stale' };
  }
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Reservation revision exhausted');
  // Never accept creator/colour overrides, or mutate the original before all
  // validation and the metadata budget check have succeeded.
  const next = { ...previous, revision: revision + 1 };
  if (message.comment !== undefined) next.comment = controlledString(message.comment, 'Reservation comment', 1024);
  if (message.assigneeId !== undefined) {
    const assigneeId = controlledString(message.assigneeId, 'Reservation assignee id', 128);
    const assignee = room.authStore.required
      ? room.authStore.findDirectoryUser(socket.identity, assigneeId)
      : { id: assigneeId || null,
          displayName: controlledString(message.assignee, 'Reservation assignee', 128, { required: true }),
          color: controlledString(message.assigneeColor ?? previous.color, 'Reservation color', 16, { required: true }) };
    if (!assignee) throw new Error('Reservation assignee account is unavailable');
    next.assigneeId = assignee.id;
    next.assignee = assignee.displayName;
    next.color = assignee.color;
  }
  const rangeFields = ['startRelative', 'endRelative'];
  if (rangeFields.some((field) => message[field] !== undefined)) {
    for (const field of rangeFields) next[field] = controlledString(message[field], `Reservation ${field}`, 4096, { required: true });
    delete next.orphaned;
    const range = resolveReservationRange(room.document, next);
    if (!range || range.start === range.end) throw new Error('Invalid reservation range');
    // Derive recovery keys from canonical text, not from client-supplied names.
    next.initialKeys = keysInsideRange(room.document.getText('content').toString(), range.start, range.end);
    if (!next.initialKeys.length || next.initialKeys.length > 1000) throw new Error('Invalid reservation key count');
  }
  room.reservations[index] = next;
  try { room.assertMetadataBudget(); }
  catch (error) { room.reservations[index] = previous; throw error; }
  room.schedulePersist();
  room.broadcastReservations();
  return { status: 'saved', revision: next.revision };
}
