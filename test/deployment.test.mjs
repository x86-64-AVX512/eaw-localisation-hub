import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFile(path.join(root, relative), 'utf8');

test('deployment artifacts keep the server private, constrained, authenticated, and recoverable', async () => {
  const [dockerfile, compose, install, backup, restore, environment, caddy, restoreModule, sourcePackage] = await Promise.all([
    read('Dockerfile'),
    read('deploy/docker-compose.yml'),
    read('deploy/install.sh'),
    read('deploy/backup.sh'),
    read('deploy/restore.sh'),
    read('deploy/.env.example'),
    read('deploy/Caddyfile'),
    read('apps/server/src/restore.mjs'),
    read('scripts/build-source-package.ps1'),
  ]);

  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /--auth", "required/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(compose, /HUB_BIND_ADDRESS:-127\.0\.0\.1/);
  assert.match(compose, /mem_limit: 384m/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /profiles: \["tls"\]/);
  assert.match(install, /bootstrap-invite\.txt/);
  assert.match(backup, /EAW_HUB_BACKUP_PASSPHRASE/);
  assert.match(backup, /\.eawhub\.enc/);
  assert.match(restore, /--force/);
  assert.match(restore, /EAW_HUB_BACKUP_PASSPHRASE/);
  assert.match(environment, /VLESS/);
  assert.match(caddy, /reverse_proxy server:3210/);
  assert.doesNotMatch(caddy, /\blog\s*\{/);
  assert.match(restoreModule, /mode:\s*0o600/);
  assert.match(restoreModule, /chmod\(targetPath,\s*0o600\)/);
  assert.match(sourcePackage, /excludedDirectoryNames/);
  for (const forbidden of ['.tools', 'auth.json', 'bootstrap-invite.txt', 'node_modules']) {
    assert.match(sourcePackage, new RegExp(forbidden.replace('.', '\\.')));
  }
});
