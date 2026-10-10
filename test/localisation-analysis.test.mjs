import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseLocalisationDiagnostics } from '../packages/shared/src/localisation-syntax.mts';
import { parseLocalisationRecords, localisationLanguage } from '../packages/shared/src/localisation-records.mts';
import { technicalInsertions, compareTechnicalInsertions } from '../packages/shared/src/localisation-markup.mts';
import { suspiciousLocalisationFormat } from '../packages/shared/src/localisation-format.mts';
import { localisationByteDiagnostics, inspectLocalisationFile } from '../apps/agent/src/localisation-file-analysis.mjs';
import { scriptedLocalisationDefinitions, collectScriptedLocalisation } from '../apps/agent/src/scripted-localisation-index.mjs';
import { auditLocalisation } from '../apps/agent/src/localisation-audit.mjs';

const checkValue = (value, options = {}) => parseLocalisationDiagnostics(`l_russian:\n KEY:0 "${value}"`, options);
async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'eaw-linter-f9-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  return repo;
}

test('loader diagnostics recover after malformed keys without a missing-reference cascade', () => {
  const diagnostics = parseLocalisationDiagnostics('l_russian:\n broken "no colon"\n ключ:0 "Русское значение"\n GOOD:0 "$EYE_missing$"', {
    knownKeys: new Set(['EYE_present']), knownPrefixes: new Set(['EYE']),
  });
  assert.deepEqual(diagnostics.map((item) => [item.code, item.lineNumber]), [['missing-colon', 2], ['invalid-key', 3]]);
  assert.match(diagnostics[0].message, /последующие/u);
  assert.deepEqual(checkValue('Русское значение'), []);
  assert.deepEqual(parseLocalisationDiagnostics("l_russian:\n foo-bar.name's:0 \"OK\""), []);
});

test('analysis records keep ranges, numeric spacing, legacy quotes and quoted inline comments', () => {
  const text = '\uFEFFl_russian:\r\n KEY: 0 "Он сказал "привет"" # comment "quoted"\r\n NEXT: "next"';
  const records = parseLocalisationRecords(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].value, 'Он сказал "привет"');
  assert.equal(records[0].fault, null);
  assert.equal(records[0].lineNumber, 2);
  assert.equal(records[0].keyStart, 1);
  assert.deepEqual(parseLocalisationDiagnostics(text), []);
  assert.equal(localisationLanguage('localisation/replace/russian/x.yml'), 'russian');
  assert.equal(localisationLanguage('', 'l_english:\n KEY:0 "OK"'), 'english');
});

test('engine escapes accept both letter cases but not carriage-return escape', () => {
  assert.deepEqual(checkValue(String.raw`a\n\N\t\T\"\\`), []);
  const issues = checkValue(String.raw`a\r`);
  assert.deepEqual(issues.map((item) => item.code), ['unknown-escape']);
});

test('UTF-8/BOM checks inspect bytes, not the BOM-less editing buffer', () => {
  assert.deepEqual(localisationByteDiagnostics(Buffer.from('\uFEFFl_russian:\n KEY:0 "Текст"')), []);
  assert.deepEqual(localisationByteDiagnostics(Buffer.from('l_russian:\n')).map((item) => item.code), ['disk-missing-utf8-bom']);
  assert.deepEqual(localisationByteDiagnostics(Buffer.from([0xef, 0xbb, 0xbf, 0xff])).map((item) => item.code), ['disk-invalid-utf8']);
  assert.deepEqual(checkValue('Текст'), []);
});

test('disk inspection is read-only, size-limited and rejects out-of-repository junctions', async (t) => {
  const repo = await fixture(t), external = await fixture(t);
  const directory = path.join(repo, 'localisation', 'russian');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'test_l_russian.yml');
  const bytes = Buffer.from('l_russian:\n KEY:0 "OK"');
  await fs.writeFile(file, bytes);
  const payload = await inspectLocalisationFile(repo, file);
  assert.equal(payload.relativePath, 'localisation/russian/test_l_russian.yml');
  assert.equal(payload.diagnostics[0].code, 'disk-missing-utf8-bom');
  assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(inspectLocalisationFile(repo, '../outside.yml'));
  await fs.writeFile(path.join(external, 'outside_l_russian.yml'), bytes);
  await fs.symlink(external, path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectLocalisationFile(repo, 'localisation/russian/escape/outside_l_russian.yml'), /outside/u);
  const handle = await fs.open(file, 'r+');
  try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(inspectLocalisationFile(repo, file), /size limit/u);
});

test('parameter icons, balanced conditionals and fragment colours are not false syntax errors', () => {
  assert.deepEqual(checkValue('£$ICON$£'), []);
  assert.deepEqual(technicalInsertions('£$ICON$£').map((item) => [item.kind, item.name]), [['icon', '$ICON$']]);
  assert.deepEqual(checkValue("[(Root.GetName ? 'A[part]' : 'B')]"), []);
  assert.equal(checkValue("[(Root.GetName ? 'A' : 'B')")[0].code, 'unclosed-conditional-loc');
  for (const value of ['§Rfragment', '§!reset']) assert.equal(checkValue(value)[0].severity, 'info');
});

test('number formats permit colour letters and adjacent percent, detect separated percent and bare dot', () => {
  for (const value of ['', '%x', '+=%0', '0|%%', '%l', '~2', '%.1Y']) assert.equal(suspiciousLocalisationFormat(value), false, value);
  for (const value of ['%0%', '%%+%', '.Y', '.']) assert.equal(suspiciousLocalisationFormat(value), true, value);
});

test('technical audit is order-independent, counts repeats and distinguishes formatter changes', () => {
  assert.deepEqual(compareTechnicalInsertions('$A$ [Root.GetName] $A$', '[Root.GetName] $A$ $A$'), []);
  assert.deepEqual(compareTechnicalInsertions('$A$', '$A$ $A$'), [{ kind: 'missing', token: 'reference:A', detail: 'RU: 1; EN: 2' }]);
  assert.equal(compareTechnicalInsertions('$VALUE|%0$', '$VALUE|%1$')[0].kind, 'formatter');
  assert.equal(compareTechnicalInsertions('$COUNT$', '$AMOUNT$').length, 2);
  assert.deepEqual(compareTechnicalInsertions('[Root.GetName_RU]', '[Root.GetName]', {
    'Root.GetName_RU': 'Root.GetName',
  }), []);
  assert.deepEqual(compareTechnicalInsertions("[(Root.GetName ? 'A B' : 'C')]", "[( Root.GetName?'A B':'C' )]"), []);
  assert.notDeepEqual(compareTechnicalInsertions("[(Root.GetName?'A B':'C')]", "[(Root.GetName?'AB':'C')]"), []);
});

test('scripted getter index ignores comments, quoted fake declarations and nested names', async (t) => {
  const source = '# defined_text = { name = GetFake }\n defined_text = {\n name = "GetRaceMembers"\n text = { name = GetNested localisation_key = "defined_text = { name = GetQuoted }" }\n }';
  const parsed = scriptedLocalisationDefinitions(source, 'common/scripted_localisation/test.txt');
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.definitions, [{ name: 'GetRaceMembers', path: 'common/scripted_localisation/test.txt', line: 3 }]);
  assert.equal(scriptedLocalisationDefinitions('defined_text = { name = GetMissing', 'test.txt').complete, false);
  const repo = await fixture(t), folder = path.join(repo, 'common', 'scripted_localisation');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, 'test.txt'); await fs.writeFile(file, source);
  const cache = new Map();
  assert.deepEqual((await collectScriptedLocalisation(repo, cache)).definitions, parsed.definitions);
  // CI hands out 8.3 temp paths (RUNNER~1); an alias of the checkout must index the same files.
  const alias = `${repo}-alias`;
  await fs.symlink(repo, alias, 'junction');
  t.after(() => fs.rm(alias, { force: true }));
  assert.deepEqual((await collectScriptedLocalisation(alias, new Map())).definitions, parsed.definitions);
  await fs.writeFile(file, 'defined_text = { name = GetUnclosed');
  assert.equal((await collectScriptedLocalisation(repo, cache)).complete, false);
});

test('likely getter typo is advisory; unknown contexts and generic local parameters are not errors', () => {
  const options = { knownGetters: new Set(['GetRaceMembers', 'GetName']) };
  const issues = checkValue('[Root.GetRaceMemebrs] [Root.GetName] [GetUnlistedCustomThing]', options);
  assert.deepEqual(issues.map((item) => [item.code, item.severity]), [['likely-getter-typo', 'warning']]);
  assert.match(issues[0].message, /GetRaceMembers/u);
  assert.match(issues[0].message, /не проверен/u);
  assert.deepEqual(checkValue('$ANSWER$', { knownKeys: new Set(), knownPrefixes: new Set() }), []);
  assert.deepEqual(checkValue('$EYE_PARAM$', { knownKeys: new Set(), knownPrefixes: new Set(['EYE']), knownParameters: new Set(['EYE_PARAM']) }), []);
});

test('reference cycles preserve case and ignore duplicate declarations and known parameters', () => {
  assert.equal(parseLocalisationDiagnostics('l_russian:\n A:0 "$B$"\n B:0 "$A$"').filter((item) => item.code === 'local-reference-cycle').length, 1);
  assert.equal(parseLocalisationDiagnostics('l_russian:\n A:0 "$A$"')[0].code, 'local-reference-cycle');
  assert.deepEqual(parseLocalisationDiagnostics('l_russian:\n A:0 "$a$"'), []);
  assert.deepEqual(parseLocalisationDiagnostics('l_russian:\n A:0 "$A$"', { knownParameters: new Set(['A']) }), []);
  assert.deepEqual(parseLocalisationDiagnostics('l_russian:\n A:0 "$A$"\n A:0 "Other"').map((item) => item.code), ['duplicate-key']);
});

test('paired audit exposes advisory differences without changing key/structure status', async (t) => {
  const repo = await fixture(t);
  const ru = path.join(repo, 'localisation', 'russian', 'test_l_russian.yml');
  const en = path.join(repo, 'localisation', 'english', 'test_l_english.yml');
  await fs.mkdir(path.dirname(ru), { recursive: true }); await fs.mkdir(path.dirname(en), { recursive: true });
  await fs.writeFile(ru, 'l_russian:\n KEY:0 "Привет $A$" # "comment"');
  await fs.writeFile(en, 'l_english:\n KEY:0 "Hello $A$ [Root.GetName]"');
  const result = await auditLocalisation(repo, ru);
  assert.equal(result.structureMatches, true);
  assert.equal(result.rows[0].status, 'ok');
  assert.equal(result.rows[0].russian.text, 'Привет $A$');
  assert.equal(result.rows[0].technicalIssues[0].token, 'getter:Root.GetName');
});
