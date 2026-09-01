import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

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
});
