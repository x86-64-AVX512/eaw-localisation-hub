import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { parseLocalisationKeys } from '../../../packages/shared/src/text.mjs';

function encodeRelativePosition(position) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

export function resolveReservationRange(document, reservation) {
  if (reservation.orphaned) return null;
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(reservation.startRelative, 'base64')),
      document,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(reservation.endRelative, 'base64')),
      document,
    );
    const text = document.getText('content');
    if (!start || !end || start.type !== text || end.type !== text) return null;
    return { start: Math.min(start.index, end.index), end: Math.max(start.index, end.index) };
  } catch {
    return null;
  }
}

export function reservationRangeForKeys(source, initialKeys) {
  const wanted = new Set((Array.isArray(initialKeys) ? initialKeys : []).map(String));
  if (wanted.size === 0) return null;
  const matches = parseLocalisationKeys(source).filter(({ key }) => wanted.has(key));
  if (matches.length === 0) return null;
  const first = matches[0];
  const last = matches.at(-1);
  const start = source.lastIndexOf('\n', Math.max(0, first.index - 1)) + 1;
  const lineBreak = source.indexOf('\n', last.index);
  const end = lineBreak < 0 ? source.length : lineBreak;
  return { start, end };
}

function reanchorReservation(text, reservation, range) {
  const previous = `${reservation.startRelative}\0${reservation.endRelative}\0${Boolean(reservation.orphaned)}`;
  if (!range) {
    reservation.orphaned = true;
  } else {
    reservation.startRelative = encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, range.start, -1),
    );
    reservation.endRelative = encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(text, range.end, 0),
    );
    delete reservation.orphaned;
  }
  return previous !== `${reservation.startRelative}\0${reservation.endRelative}\0${Boolean(reservation.orphaned)}`;
}

export function repairReservationAnchors(document, reservations, { force = false } = {}) {
  const text = document.getText('content');
  const source = text.toString();
  let changed = false;
  for (const reservation of reservations) {
    const current = resolveReservationRange(document, reservation);
    if (!force && current && current.start !== current.end) continue;
    const range = reservationRangeForKeys(source, reservation.initialKeys);
    if (reanchorReservation(text, reservation, range)) changed = true;
  }
  return changed;
}
