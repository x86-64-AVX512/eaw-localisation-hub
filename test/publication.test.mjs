import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { DISPLAY_VERSION, SEMVER_VERSION } from '../packages/shared/src/constants.mjs';

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('release versions stay consistent across package and Windows metadata', async () => {
  const [manifestText, lockText, versionText, installer] = await Promise.all([
    read('package.json'), read('package-lock.json'), read('VERSION'), read('installer/EaWLocalisationHub.iss'),
  ]);
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);
  const displayMatch = /^(\d+\.\d+\.\d+)F(\d+)$/u.exec(DISPLAY_VERSION);
  assert.ok(displayMatch);
  assert.equal(manifest.version, SEMVER_VERSION);
  assert.equal(lock.version, SEMVER_VERSION);
  assert.equal(lock.packages[''].version, SEMVER_VERSION);
  assert.equal(manifest.eawHub.displayVersion, DISPLAY_VERSION);
  assert.equal(manifest.eawHub.windowsFileVersion, `${displayMatch[1]}.${displayMatch[2]}`);
  assert.equal(versionText.trim(), DISPLAY_VERSION);
  assert.match(installer, new RegExp(`#define AppVersion "${DISPLAY_VERSION}"`, 'u'));
});

test('public repository metadata declares GPL-2.0-only and publication safeguards', async () => {
  const [manifest, ignore, dockerIgnore, license, workflow, audit] = await Promise.all([
    read('package.json'), read('.gitignore'), read('.dockerignore'), read('LICENSE'),
    read('.github/workflows/ci.yml'), read('scripts/check-publication.mjs'),
  ]);
  assert.equal(JSON.parse(manifest).license, 'GPL-2.0-only');
  for (const pattern of ['output/', '.playwright-cli/', 'deploy/.env', 'deploy/backups/']) assert.match(ignore, new RegExp(pattern.replace('.', '\\.')));
  assert.match(dockerIgnore, /deploy\/\.env/);
  assert.match(license, /GNU GENERAL PUBLIC LICENSE\s+Version 2/);
  assert.match(workflow, /submodules: recursive/);
  assert.match(workflow, /scripts\/bootstrap-zig\.ps1/);
  assert.match(workflow, /npm run check:publication/);
  assert.match(audit, /Public infrastructure IP detected/);

  const scriptDirectory = new URL('../scripts/', import.meta.url);
  const scriptNames = (await readdir(scriptDirectory)).filter((name) => name.endsWith('.ps1'));
  const powershellSources = await Promise.all(scriptNames.map((name) => readFile(new URL(name, scriptDirectory), 'utf8')));
  assert.doesNotMatch(powershellSources.join('\n'), /\bGet-FileHash\b/u);
  assert.match(powershellSources.join('\n'), /Get-EawFileSha256/u);
});
