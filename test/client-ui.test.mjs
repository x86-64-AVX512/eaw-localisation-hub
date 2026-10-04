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
  assert.match(agentUi, /\$exitTrayItem = \$trayMenu\.Items\.Add\(\(Get-EawUiText -Text 'Закрыть Agent'\)\)/u);
});

test('Agent can launch Review from its main window', () => {
  assert.match(agentUi, /\$reviewButton\.Text = \(Get-EawUiText -Text 'Запустить Review'\)/u);
  assert.match(agentUi, /\$reviewButton\.Enabled = \$false/u);
  assert.match(agentUi, /\$reviewButton\.Add_Click\([\s\S]*start-hub\.ps1/u,
    'the Agent button must use the same remembered-workspace launcher as the desktop shortcut');
  assert.match(agentUi, /\$reviewButton\.Enabled = \$script:agentProcess -and -not \$script:agentProcess\.HasExited/u);
});

test('Russian client UI does not use the hybrid recovery-code wording', () => {
  assert.doesNotMatch(`${agentUi}\n${adminUi}`, /recovery-код/iu);
  assert.match(agentUi, /Приглашение \/ код восстановления:/u);
  assert.match(adminUi, /Разрешить новый код восстановления/u);
});

test('only the confirmed Agent update button requests installation', () => {
  assert.match(agentUi, /\$updateClientButton\.Text = \(Get-EawUiText -Text 'Обновить клиент…'\)/u);
  const handler = agentUi.slice(agentUi.indexOf('$updateClientButton.Add_Click({'), agentUi.indexOf('$showTrayItem.Add_Click'));
  assert.match(handler, /MessageBox\]::Show\(\$form/u);
  assert.match(handler, /'YesNo', 'Question', 'Button2'/u, 'No is the default confirmation choice');
  assert.match(handler, /if \(\$answer -ne \[System\.Windows\.Forms\.DialogResult\]::Yes\) \{ return \}/u);
  assert.match(handler, /Start-ClientUpdateCheck -Install/u);
  assert.equal((agentUi.match(/Start-ClientUpdateCheck -Install/gu) ?? []).length, 1,
    'startup, timers and compatibility checks must never request an install');
  assert.match(agentUi, /\$updateTimer\.Add_Tick\(\{ try \{ Start-ClientUpdateCheck \}/u);
});
