import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('Windows repository-sync UI settings and signals obey the running Agent contract', { skip: process.platform !== 'win32' }, () => {
  const script = path.resolve(import.meta.dirname, '../scripts/verify-repository-sync.ps1');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /notification deduplication passed/u);
});
