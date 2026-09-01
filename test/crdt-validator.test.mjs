import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  CrdtUpdateValidator,
  CrdtValidationError,
} from '../apps/server/src/crdt-validator.mjs';

function sampleUpdate() {
  const document = new Y.Doc();
  document.getText('content').insert(0, 'l_russian:\n key:0 "Текст"');
  const update = Y.encodeStateAsUpdate(document);
  document.destroy();
  return update;
}

test('CRDT validator isolates decoding and reports the resulting state budget', async (t) => {
  const validator = new CrdtUpdateValidator({ maximumStateBytes: 1024 * 1024 });
  t.after(() => validator.close());
  const update = sampleUpdate();
  const result = await validator.validate(update);
  assert.ok(result.stateBytes >= update.byteLength);
  assert.ok(result.elapsedMilliseconds >= 0);
});

test('CRDT validator rejects malformed and expansion-limited updates', async (t) => {
  const validator = new CrdtUpdateValidator({ maximumStateBytes: 8 });
  t.after(() => validator.close());
  await assert.rejects(() => validator.validate(Uint8Array.of(255, 255, 255)), CrdtValidationError);
  await assert.rejects(() => validator.validate(sampleUpdate()), /expands beyond/);
});

test('CRDT validator has a bounded global queue', async (t) => {
  const validator = new CrdtUpdateValidator({ maximumStateBytes: 1024 * 1024 });
  t.after(() => validator.close());
  const update = sampleUpdate();
  const jobs = Array.from({ length: 80 }, () => validator.validate(update).catch((error) => error));
  const results = await Promise.all(jobs);
  assert.ok(results.some((result) => result instanceof CrdtValidationError
    && result.code === 'crdt-validation-overloaded'));
});
