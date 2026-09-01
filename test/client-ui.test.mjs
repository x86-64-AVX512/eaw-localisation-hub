import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentUi = fs.readFileSync(path.join(projectRoot, 'scripts', 'start-agent-ui.ps1'), 'utf8');
const adminUi = fs.readFileSync(path.join(projectRoot, 'scripts', 'server-admin-ui.ps1'), 'utf8');

test('fresh Agent setup leaves the participant name empty', () => {
  assert.match(agentUi, /\$nameBox\.Text = if \(\$saved\.User\) \{ \[string\]\$saved\.User \} else \{ '' \}/u);
  assert.doesNotMatch(agentUi, /\[Environment\]::UserName/u);
});

test('Agent exposes a full colour picker and an explicit tray close action', () => {
  assert.match(agentUi, /\[System\.Windows\.Forms\.ColorDialog\]::new\(\)/u);
  assert.match(agentUi, /\$dialog\.FullOpen = \$true/u);
  assert.match(agentUi, /\$exitTrayItem = \$trayMenu\.Items\.Add\('Закрыть Agent'\)/u);
});

test('Russian client UI does not use the hybrid recovery-code wording', () => {
  assert.doesNotMatch(`${agentUi}\n${adminUi}`, /recovery-код/iu);
  assert.match(agentUi, /Приглашение \/ код восстановления:/u);
  assert.match(adminUi, /Разрешить новый код восстановления/u);
});
