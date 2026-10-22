import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertSecureNodeVersion, isSecureNodeVersion } from '../scripts/check-node-runtime.mjs';

test('Node security policy rejects old patches in every supported major and unaudited majors', () => {
  for (const version of ['22.18.0', '22.22.3', '22.23.3', '24.21.9', '24.22.0', '26.12.0', '20.99.0', '23.99.0', '25.99.0', '27.0.0', '22.23.4-rc.1', '', 'garbage']) {
    assert.equal(isSecureNodeVersion(version), false, version);
    assert.throws(() => assertSecureNodeVersion(version), /eMudhra security update/u, version);
  }
  for (const version of ['22.23.4', 'v22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0']) {
    assert.equal(isSecureNodeVersion(version), true, version);
    assert.doesNotThrow(() => assertSecureNodeVersion(version), version);
  }
});

test('both container build paths enforce the runtime security policy', async () => {
  const [full, incremental] = await Promise.all(['Dockerfile', 'deploy/Dockerfile.incremental'].map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
  assert.match(full, /^FROM node:22\.23\.4-alpine/mu);
  assert.match(full, /apk upgrade --no-cache ca-certificates/u);
  assert.match(full, /org\.eawhub\.runtime-security="2026-10-21"/u);
  for (const source of [full, incremental]) {
    assert.match(source, /COPY scripts\/check-node-runtime\.mjs/u);
    assert.match(source, /RUN node scripts\/check-node-runtime\.mjs/u);
  }
});
