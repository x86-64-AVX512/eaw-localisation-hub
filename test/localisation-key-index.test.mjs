import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectLocalisationKeys } from '../apps/agent/src/localisation-key-index-worker.mjs';
import { getLocalisationKeyIndex } from '../apps/agent/src/localisation-key-index.mjs';

test('local key index runs off the Agent event loop and includes versionless keys in all languages', async (t) => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-localisation-keys-'));
  t.after(() => fs.rm(repository, { recursive: true, force: true }));
  const russian = path.join(repository, 'localisation', 'russian');
  const english = path.join(repository, 'localisation', 'english');
  await fs.mkdir(russian, { recursive: true });
  await fs.mkdir(english, { recursive: true });
  await fs.writeFile(path.join(russian, 'a.yml'), 'l_russian:\n EYE_one:0 "Один"\n # fake:0 "нет"\n');
  await fs.writeFile(path.join(english, 'a.yml'), 'l_english:\n EYE_two: "Two"\n');
  const direct = await collectLocalisationKeys(repository);
  assert.equal(direct.complete, true);
  assert.equal(direct.files, 2);
  assert.deepEqual(new Set(direct.keys), new Set(['EYE_one', 'EYE_two']));
  const threaded = await getLocalisationKeyIndex(repository);
  assert.deepEqual(new Set(threaded.keys), new Set(direct.keys));
});
