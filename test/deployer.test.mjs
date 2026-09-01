import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  createServerPayload,
  deploymentId,
  fingerprintSha256,
  remoteDeploymentCommand,
  shellQuote,
  validateDeploymentRequest,
} from '../apps/deployer/src/deployment-core.mjs';

test('deployer validates SSH targets and refuses dangerous remote roots', () => {
  const request = validateDeploymentRequest({
    host: '203.0.113.10', port: 22, username: 'root', remoteRoot: '/opt/eaw-localisation-hub/', password: 'secret',
  });
  assert.equal(request.remoteRoot, '/opt/eaw-localisation-hub');
  assert.throws(() => validateDeploymentRequest({ ...request, remoteRoot: '/' }), /безопасным абсолютным/);
  assert.throws(() => validateDeploymentRequest({ ...request, remoteRoot: '/opt/../root' }), /безопасным абсолютным/);
  assert.throws(() => validateDeploymentRequest({ ...request, host: 'host; reboot' }), /адрес VPS/);
});

test('deployer pins host keys and safely quotes shell values', () => {
  assert.equal(fingerprintSha256(Buffer.from('host-key')), 'SHA256:CfEOS9w3pHE4KlqjcQFwWyWMmyRvvPoehydyMhTxpzg');
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  assert.match(deploymentId('0.8.6F4', new Date('2026-09-01T12:34:56Z')), /^0\.8\.6F4-20260901T123456Z$/);
});

test('remote deployment verifies its payload, preserves state, checks health, and rolls back', () => {
  const command = remoteDeploymentCommand({
    remoteRoot: '/opt/eaw-localisation-hub',
    uploadPath: '/tmp/release.tar.gz',
    releaseId: '0.8.6F4-test',
    expectedDigest: 'a'.repeat(64),
  });
  assert.match(command, /sha256sum -c/);
  assert.match(command, /! -name \.env ! -name backups ! -name rollbacks/);
  assert.match(command, /Deployment failed; restoring previous release/);
  assert.match(command, /trying the existing server image as an offline base/);
  assert.match(command, /Dockerfile\.incremental/);
  assert.match(command, /docker compose up -d --no-build server/);
  assert.match(command, /\/health/);
  assert.match(command, /docker compose build server/);
});

test('server deployment payload excludes runtime secrets and data', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eaw-deployer-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of ['apps/server', 'packages/shared', 'deploy/backups', 'scripts']) await mkdir(path.join(root, relative), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'Dockerfile'), 'FROM scratch'),
    writeFile(path.join(root, 'package.json'), '{}'),
    writeFile(path.join(root, 'package-lock.json'), '{}'),
    writeFile(path.join(root, 'VERSION'), '0.8.6F4'),
    writeFile(path.join(root, 'apps/server/main.mjs'), 'export {}'),
    writeFile(path.join(root, 'packages/shared/constants.mjs'), 'export {}'),
    writeFile(path.join(root, 'deploy/docker-compose.yml'), 'services: {}'),
    writeFile(path.join(root, 'scripts/manage-server.mjs'), 'export {}'),
    writeFile(path.join(root, 'deploy/.env'), 'SECRET=yes'),
    writeFile(path.join(root, 'deploy/backups/private.enc'), 'private'),
  ]);
  const payload = await createServerPayload(root, '0.8.6F4');
  context.after(payload.dispose);
  assert.match(payload.digest, /^[a-f0-9]{64}$/);
  const listing = spawnSync('tar.exe', ['-tzf', payload.archivePath], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.doesNotMatch(listing.stdout, /\.env|private\.enc|backups\//);
  assert.match(listing.stdout, /apps\/server\/main\.mjs/);
  assert.match(listing.stdout, /scripts\/manage-server\.mjs/);
  assert.equal(JSON.parse(await readFile(path.join(path.dirname(payload.archivePath), 'payload/deployment.json'), 'utf8')).version, '0.8.6F4');
});
