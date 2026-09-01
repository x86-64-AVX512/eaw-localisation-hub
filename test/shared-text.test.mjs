import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  applyUtf8ByteEdit,
  computeSingleReplace,
  keysInsideRange,
  normaliseLineEndings,
  normaliseTrackedPath,
  preserveLineEndings,
  readTrackedTextFile,
  withoutUtf8Bom,
  withUtf8Bom,
  writeTrackedTextFile,
  utf16IndexToUtf8ByteOffset,
  utf8ByteOffsetToUtf16Index,
} from '../packages/shared/src/text.mjs';

test('collaborative text removes BOM while materialised localisation restores it', () => {
  assert.equal(withoutUtf8Bom('\uFEFFl_russian:'), 'l_russian:');
  assert.equal(withoutUtf8Bom('l_russian:'), 'l_russian:');
  assert.equal(withUtf8Bom('l_russian:'), '\uFEFFl_russian:');
  assert.equal(withUtf8Bom('\uFEFFl_russian:'), '\uFEFFl_russian:');
});

test('line-ending helpers keep the collaborative model on LF and preserve worktree format', () => {
  assert.equal(normaliseLineEndings('one\r\ntwo\rthree\n'), 'one\ntwo\nthree\n');
  assert.equal(preserveLineEndings('one\ntwo\n', 'old\r\ntext\r\n'), 'one\r\ntwo\r\n');
  assert.equal(preserveLineEndings('one\r\ntwo\r\n', 'old\ntext\n'), 'one\ntwo\n');
});

test('tracked paths reject canonical junction escapes', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-hub-path-test-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const repository = path.join(sandbox, 'repo');
  const russian = path.join(repository, 'localisation', 'russian');
  const outside = path.join(sandbox, 'outside');
  fs.mkdirSync(russian, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const outsideFile = path.join(outside, 'secret.yml');
  fs.writeFileSync(outsideFile, 'secret', 'utf8');
  const junction = path.join(russian, 'escaped');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => normaliseTrackedPath(repository, path.join(junction, 'secret.yml')),
    /resolves outside/,
  );
});

test('tracked paths preserve valid repository-relative localisation paths', (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-hub-path-test-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const file = path.join(repository, 'localisation', 'russian', 'valid_l_russian.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'l_russian:', 'utf8');
  assert.equal(normaliseTrackedPath(repository, file), 'localisation/russian/valid_l_russian.yml');
});

test('tracked paths include localisation replace files', (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-hub-replace-path-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const file = path.join(repository, 'localisation', 'replace', 'russian', 'override.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'l_russian:', 'utf8');
  assert.equal(normaliseTrackedPath(repository, file), 'localisation/replace/russian/override.yml');
});

test('tracked paths include English localisation files', (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-hub-english-path-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const file = path.join(repository, 'localisation', 'english', 'example_l_english.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'l_english:', 'utf8');
  assert.equal(normaliseTrackedPath(repository, file), 'localisation/english/example_l_english.yml');
});

test('secure tracked reads use an identity-checked handle', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-hub-secure-read-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const repository = path.join(sandbox, 'repo');
  const russian = path.join(repository, 'localisation', 'russian');
  const outside = path.join(sandbox, 'outside');
  fs.mkdirSync(russian, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const valid = path.join(russian, 'valid_l_russian.yml');
  fs.writeFileSync(valid, 'l_russian:', 'utf8');
  assert.equal(await readTrackedTextFile(repository, valid), 'l_russian:');

  const outsideFile = path.join(outside, 'secret.yml');
  fs.writeFileSync(outsideFile, 'secret', 'utf8');
  const junction = path.join(russian, 'escaped');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    readTrackedTextFile(repository, path.join(junction, 'secret.yml')),
    /resolves outside/,
  );
});

test('secure tracked writes stay inside the repository and update the opened file', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-hub-secure-write-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const repository = path.join(sandbox, 'repo');
  const russian = path.join(repository, 'localisation', 'russian');
  const outside = path.join(sandbox, 'outside');
  fs.mkdirSync(russian, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const valid = path.join(russian, 'valid_l_russian.yml');
  fs.writeFileSync(valid, 'l_russian:', 'utf8');
  await writeTrackedTextFile(repository, valid, 'l_russian:\n key:0 "Перевод"\n');
  assert.equal(fs.readFileSync(valid, 'utf8'), 'l_russian:\n key:0 "Перевод"\n');

  const outsideFile = path.join(outside, 'secret.yml');
  fs.writeFileSync(outsideFile, 'secret', 'utf8');
  const junction = path.join(russian, 'escaped-write');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    writeTrackedTextFile(repository, path.join(junction, 'secret.yml'), 'overwritten'),
    /resolves outside/,
  );
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'secret');
});

test('secure tracked writes preserve CRLF and skip byte-identical materialisation', async (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-hub-eol-write-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const directory = path.join(repository, 'localisation', 'russian');
  const file = path.join(directory, 'format_l_russian.yml');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, '\uFEFFl_russian:\r\n key:0 "Text"\r\n', 'utf8');

  assert.equal(await writeTrackedTextFile(
    repository,
    file,
    '\uFEFFl_russian:\n key:0 "Changed"\n',
  ), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '\uFEFFl_russian:\r\n key:0 "Changed"\r\n');
  const before = fs.statSync(file);
  assert.equal(await writeTrackedTextFile(
    repository,
    file,
    '\uFEFFl_russian:\n key:0 "Changed"\n',
  ), false);
  const after = fs.statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('materialisation repairs an LF worktree file when Git attributes require CRLF', async (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-hub-git-eol-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const runGit = (...args) => execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  });
  runGit('init', '--quiet');
  runGit('config', 'user.name', 'EaW Hub Test');
  runGit('config', 'user.email', 'test@example.invalid');
  runGit('config', 'core.autocrlf', 'true');
  fs.writeFileSync(path.join(repository, '.gitattributes'), '*.yml text=auto\n', 'utf8');
  const directory = path.join(repository, 'localisation', 'russian');
  const file = path.join(directory, 'tracked_l_russian.yml');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, '\uFEFFl_russian:\n key:0 "Text"\n', 'utf8');
  runGit('add', '.gitattributes', 'localisation/russian/tracked_l_russian.yml');
  runGit('commit', '--quiet', '-m', 'fixture');
  fs.unlinkSync(file);
  runGit('checkout', '--', 'localisation/russian/tracked_l_russian.yml');
  assert.match(fs.readFileSync(file, 'utf8'), /\r\n/u);
  fs.writeFileSync(file, '\uFEFFl_russian:\n key:0 "Text"\n', 'utf8');

  assert.equal(await writeTrackedTextFile(
    repository,
    file,
    '\uFEFFl_russian:\n key:0 "Text"\n',
  ), true);
  assert.match(fs.readFileSync(file, 'utf8'), /\r\n/u);
  assert.equal(runGit('status', '--porcelain', '--', 'localisation/russian/tracked_l_russian.yml'), '');
});

test('UTF-8 byte offsets round-trip through Cyrillic and surrogate pairs', () => {
  const text = 'AБ🦄Z';
  for (const index of [0, 1, 2, 4, 5]) {
    const byteOffset = utf16IndexToUtf8ByteOffset(text, index);
    assert.equal(utf8ByteOffsetToUtf16Index(text, byteOffset), index);
  }
  assert.throws(() => utf8ByteOffsetToUtf16Index(text, 2), /splits a code point/);
  assert.throws(() => utf16IndexToUtf8ByteOffset(text, 3), /splits a surrogate pair/);
});

test('a byte edit does not corrupt Cyrillic text', () => {
  const text = 'Привет, мир';
  const start = Buffer.byteLength('Привет, ', 'utf8');
  const removed = Buffer.byteLength('мир', 'utf8');
  assert.equal(applyUtf8ByteEdit(text, start, removed, 'Эквестрия'), 'Привет, Эквестрия');
});

test('single replacement reconstructs the target text', () => {
  const previous = 'key:0 "Старый 🦄 текст"';
  const next = 'key:0 "Новый 🦄 перевод"';
  const replacement = computeSingleReplace(previous, next);
  assert.ok(replacement);
  assert.equal(
    applyUtf8ByteEdit(previous, replacement.positionByte, replacement.deleteBytes, replacement.insertText),
    next,
  );
});

test('localisation keys are discovered inside a selection', () => {
  const text = [
    'l_russian:',
    ' key_one:0 "Один"',
    ' # comment',
    ' key_two:0 "Два"',
    '',
  ].join('\r\n');
  const start = text.indexOf(' key_one');
  const end = text.indexOf(' key_two') + ' key_two:0 "Два"'.length;
  assert.deepEqual(keysInsideRange(text, start, end), ['key_one', 'key_two']);
});
