import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { remoteDeploymentCommand, systemTar } from '../apps/deployer/src/deployment-core.mjs';

const shell = process.platform === 'win32'
  ? [path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe'), 'C:/Program Files/Git/bin/bash.exe'].find(file => fs.existsSync(file))
  : '/bin/bash';

const fakeDocker = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_AUDIT"
if [ "$1" = compose ]; then
  case "$2" in
    version) exit 0 ;;
    images) echo previous-image; exit 0 ;;
    build) [ "$FAKE_MODE" = online ]; exit $? ;;
    config) echo eaw-hub:fixture; exit 0 ;;
    up|logs) exit 0 ;;
  esac
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  if [ "$FAKE_MODE" = offline-safe ]; then echo 2026-10-21; else echo legacy; fi
  exit 0
fi
if [ "$1" = build ]; then exit 0; fi
echo "Unexpected Docker invocation: $*" >&2
exit 90
`;

for (const mode of ['online', 'online-failed', 'offline-safe', 'offline-unsafe']) {
  test(`deployment preserves local TLS overrides and handles ${mode} images`, { skip: !shell }, async context => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'eaw-deploy-security-'));
    context.after(() => rm(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'installed');
    const payload = path.join(temporary, 'payload');
    const bin = path.join(temporary, 'bin');
    const upload = path.join(temporary, 'release.tar.gz');
    const audit = path.join(temporary, 'docker.log');
    for (const base of [root, payload]) {
      for (const folder of ['apps/server', 'packages/shared', 'scripts', 'deploy/backups', 'deploy/rollbacks']) await mkdir(path.join(base, folder), { recursive: true });
      for (const file of ['Dockerfile', 'package.json', 'package-lock.json', 'VERSION', 'apps/server/version.txt', 'scripts/check-node-runtime.mjs', 'deploy/docker-compose.yml', 'deploy/Dockerfile.incremental']) {
        await writeFile(path.join(base, file), base === root ? 'old' : 'new');
      }
    }
    const overrides = ['docker-compose.override.yml', 'docker-compose.override.yaml', 'compose.override.yml', 'compose.override.yaml'];
    for (const name of overrides) await writeFile(path.join(root, 'deploy', name), `local trust config ${name}\n`);
    await writeFile(path.join(root, 'deploy/.env'), 'HUB_PORT=3210\n');
    await writeFile(path.join(root, 'deploy/backups/keep.txt'), 'backup');
    await writeFile(path.join(root, 'deploy/rollbacks/keep.txt'), 'rollback');
    await mkdir(bin);
    await writeFile(path.join(bin, 'docker'), fakeDocker, { mode: 0o755 });
    const packed = spawnSync(systemTar(), ['-czf', upload, '-C', payload, '.'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const digest = createHash('sha256').update(await readFile(upload)).digest('hex');
    const posixRoot = spawnSync(shell, ['--noprofile', '--norc', '-c', 'pwd -P'], { cwd: temporary, encoding: 'utf8' });
    assert.equal(posixRoot.status, 0, posixRoot.stderr);
    const directory = posixRoot.stdout.trim();
    const command = remoteDeploymentCommand({
      remoteRoot: `${directory}/installed`, uploadPath: `${directory}/release.tar.gz`,
      releaseId: 'security-test', expectedDigest: digest, preferOffline: mode.startsWith('offline'),
    });
    const prelude = `export PATH="$FAKE_BIN:$PATH"\nchmod +x "$FAKE_BIN/docker"\ncurl() { printf '%s\\n' '{"ok":true}'; }\n`;
    const result = spawnSync(shell, ['--noprofile', '--norc', '-c', prelude + command], {
      cwd: temporary, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, FAKE_BIN: `${directory}/bin`, FAKE_AUDIT: `${directory}/docker.log`, FAKE_MODE: mode },
    });
    const failed = mode === 'offline-unsafe' || mode === 'online-failed';
    assert.equal(result.status, failed ? 30 : 0, result.stderr || result.stdout);
    for (const name of overrides) assert.equal(await readFile(path.join(root, 'deploy', name), 'utf8'), `local trust config ${name}\n`);
    assert.equal(await readFile(path.join(root, 'deploy/.env'), 'utf8'), 'HUB_PORT=3210\n');
    assert.equal(await readFile(path.join(root, 'deploy/backups/keep.txt'), 'utf8'), 'backup');
    assert.equal(await readFile(path.join(root, 'deploy/rollbacks/keep.txt'), 'utf8'), 'rollback');
    const expected = failed ? 'old' : 'new';
    assert.equal(await readFile(path.join(root, 'VERSION'), 'utf8'), expected);
    assert.equal(await readFile(path.join(root, 'scripts/check-node-runtime.mjs'), 'utf8'), expected);
    const operations = await readFile(audit, 'utf8');
    if (mode.startsWith('online')) assert.match(operations, /compose build --pull server/u);
    if (mode === 'offline-safe') assert.match(operations, /build --build-arg PREVIOUS_IMAGE=previous-image/u);
    if (failed) {
      assert.doesNotMatch(operations, /build --build-arg/u);
      assert.match(result.stderr, /Offline base lacks the required Node\.js and CA security baseline/u);
      assert.match(result.stderr, /restoring previous release/u);
    }
  });
}
