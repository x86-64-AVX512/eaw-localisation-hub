import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexExecutable } from '../apps/agent/src/codex-executable.mjs';

async function createNpmPrefix(t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const npmPrefix = await fs.mkdtemp(path.join(tempRoot, 'eaw-codex-npm-'));
  t.after(async () => {
    const resolved = await fs.realpath(npmPrefix);
    assert.equal(resolved, npmPrefix);
    assert.equal(path.dirname(resolved), tempRoot);
    await fs.rm(resolved, { recursive: true });
  });
  await fs.writeFile(path.join(npmPrefix, 'codex.cmd'), '');
  return npmPrefix;
}

test('Windows Codex discovery finds native binaries in supported npm layouts', async (t) => {
  for (const [architecture, target] of [
    ['x64', 'x86_64-pc-windows-msvc'],
    ['arm64', 'aarch64-pc-windows-msvc'],
  ]) {
    const platformPackage = `codex-win32-${architecture}`;
    const layouts = [
      ['nested platform package', ['codex', 'node_modules', '@openai', platformPackage]],
      ['hoisted platform package', [platformPackage]],
      ['vendor inside the main package', ['codex']],
    ];

    for (const [layout, packageParts] of layouts) {
      for (const executableDirectory of ['bin', 'codex']) {
        await t.test(`${architecture}, ${layout}, ${executableDirectory}/codex.exe`, async (t) => {
          const npmPrefix = await createNpmPrefix(t);
          const executable = path.join(
            npmPrefix,
            'node_modules',
            '@openai',
            ...packageParts,
            'vendor',
            target,
            executableDirectory,
            'codex.exe',
          );
          await fs.mkdir(path.dirname(executable), { recursive: true });
          await fs.writeFile(executable, '');

          assert.equal(codexExecutable({ Path: npmPrefix }, 'win32', architecture), executable);
        });
      }
    }
  }
});

test('Windows Codex discovery reports a missing binary when only the npm shim exists', async (t) => {
  const npmPrefix = await createNpmPrefix(t);

  assert.throws(() => codexExecutable({ Path: npmPrefix }, 'win32', 'x64'), { message: /^Codex CLI не найден\./u });
});
