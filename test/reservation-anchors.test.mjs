import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import * as Y from 'yjs';
import {
  repairReservationAnchors,
  reservationRangeForKeys,
  resolveReservationRange,
} from '../apps/server/src/reservation-anchors.mjs';

function encoded(position) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

function reservationFor(text, source, keys) {
  return {
    id: 'reservation',
    initialKeys: keys,
    startRelative: encoded(Y.createRelativePositionFromTypeIndex(text, source.indexOf(keys[0]), -1)),
    endRelative: encoded(Y.createRelativePositionFromTypeIndex(text, source.length, 0)),
  };
}

test('reservation key fallback spans the surviving localisation lines', () => {
  const source = 'l_russian:\r\n first:0 "One"\r\n # note\r\n second:0 "Two"\r\n third:0 "Three"\r\n';
  const range = reservationRangeForKeys(source, ['first', 'second']);
  assert.equal(source.slice(range.start, range.end), ' first:0 "One"\r\n # note\r\n second:0 "Two"\r');
});

test('reservation anchors are rebuilt after full replacement and recover when keys return', () => {
  const document = new Y.Doc();
  const text = document.getText('content');
  const original = 'l_russian:\n first:0 "One"\n second:0 "Two"\n';
  text.insert(0, original);
  const reservation = reservationFor(text, original, ['second']);

  text.delete(0, text.length);
  text.insert(0, 'l_russian:\n first:0 "Changed"\n second:0 "Still here"\n');
  assert.equal(resolveReservationRange(document, reservation).start, 0,
    'the uncorrected Yjs anchor should demonstrate the collapse');
  assert.equal(repairReservationAnchors(document, [reservation], { force: true }), true);
  let range = resolveReservationRange(document, reservation);
  assert.match(text.toString().slice(range.start, range.end), /second:0 "Still here"/u);
  assert.equal(reservation.orphaned, undefined);

  text.delete(0, text.length);
  text.insert(0, 'l_russian:\n first:0 "Only"\n');
  repairReservationAnchors(document, [reservation], { force: true });
  assert.equal(reservation.orphaned, true);
  assert.equal(resolveReservationRange(document, reservation), null);

  text.delete(0, text.length);
  text.insert(0, original);
  repairReservationAnchors(document, [reservation], { force: true });
  range = resolveReservationRange(document, reservation);
  assert.match(text.toString().slice(range.start, range.end), /second:0 "Two"/u);
  assert.equal(reservation.orphaned, undefined);
  document.destroy();
});
