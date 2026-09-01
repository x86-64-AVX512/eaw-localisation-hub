import test from 'node:test';
import assert from 'node:assert/strict';

import { DocumentBinding } from '../apps/agent/src/document-binding.mjs';

function unsynchronisedBinding() {
  const binding = Object.create(DocumentBinding.prototype);
  binding.requireState = () => ({ initialised: false });
  return binding;
}

test('edits arriving before documentReady are ignored without a user-facing error', () => {
  const binding = unsynchronisedBinding();
  assert.equal(binding.edit({}, 'C:\\repo\\localisation\\russian\\x.yml', {
    positionByte: 0,
    deleteBytes: 0,
    insertBase64: 'YQ==',
  }), false);
});

test('snapshots arriving before documentReady are ignored without a user-facing error', () => {
  const binding = unsynchronisedBinding();
  assert.equal(binding.snapshot({}, 'C:\\repo\\localisation\\russian\\x.yml', {
    textBase64: 'YQ==',
  }), false);
});
