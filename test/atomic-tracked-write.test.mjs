import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeTrackedTextFile } from '../packages/shared/src/text.mjs';

function fixture(t) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-atomic-write-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const directory = path.join(repository, 'localisation', 'russian');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'test.yml');
  const original = '\uFEFFl_russian:\r\n key:0 "Original"\r\n';
  fs.writeFileSync(target, original);
  return { repository, directory, target, original };
}

test('failed atomic replacement leaves the complete original in place and cleans its staging file', async (t) => {
  const { repository, directory, target, original } = fixture(t);
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to !== target) return rename(from, to);
    assert.equal(fs.readFileSync(target, 'utf8'), original, 'the destination was never truncated');
    assert.match(fs.readFileSync(from, 'utf8'), /"Changed"/u);
    throw Object.assign(new Error('Simulated replacement failure'), { code: 'EACCES' });
  });
  await assert.rejects(writeTrackedTextFile(repository, target, original.replace('Original', 'Changed')), /Simulated/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory), ['test.yml']);
});

test('failure while staging cannot leave a partially overwritten tracked file', async (t) => {
  const { repository, directory, target, original } = fixture(t);
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      const write = handle.write.bind(handle);
      handle.write = async (...writeArgs) => {
        await write(writeArgs[0], 0, 3, 0);
        throw new Error('Simulated disk full');
      };
    }
    return handle;
  });
  await assert.rejects(writeTrackedTextFile(repository, target, original.replace('Original', 'Changed')), /disk full/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory), ['test.yml']);
});

test('an invalidated save is cancelled just before replacement', async (t) => {
  const { repository, directory, target, original } = fixture(t);
  let checked = false;
  const changed = await writeTrackedTextFile(repository, target, original.replace('Original', 'Changed'), {
    isCurrent() { checked = true; return false; },
  });
  assert.equal(checked, true); assert.equal(changed, false);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory), ['test.yml']);
});

test('an external change during staging is not overwritten', async (t) => {
  const { repository, target, original } = fixture(t);
  const open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        fs.writeFileSync(target, original.replace('Original', 'External checkout'));
      };
    }
    return handle;
  });
  await assert.rejects(writeTrackedTextFile(repository, target, original.replace('Original', 'Changed')), /changed during/);
  assert.match(fs.readFileSync(target, 'utf8'), /External checkout/u);
});
