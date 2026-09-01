import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentHub = fs.readFileSync(path.join(projectRoot, 'apps', 'agent', 'src', 'agent-hub.mjs'), 'utf8');
const reviewApp = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'app.js'), 'utf8');
const ticketPanel = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'ticket-panel.js'), 'utf8');

test('recovery warning waits for an explicit server-confirmed status', () => {
  assert.match(agentHub, /recoveryStatus: this\.identity\?\.recoveryStatus \?\? ''/u);
  assert.match(reviewApp, /recoveryStatus: message\.recoveryStatus \?\? ''/u);
  assert.doesNotMatch(agentHub, /this\.identity\?\.recoveryStatus \?\? 'setup_required'/u);
  assert.doesNotMatch(reviewApp, /message\.recoveryStatus \?\? 'setup_required'/u);
});

test('ticket panel retries transient initialisation failures and can recover controls', () => {
  assert.match(ticketPanel, /async function reloadWithRetry\(\)/u);
  assert.match(ticketPanel, /scheduleRetry\(\)/u);
  assert.match(ticketPanel, /setAvailability\(true\)/u);
  assert.match(ticketPanel, /Math\.min\(retryDelay \* 2, 30_000\)/u);
  assert.match(reviewApp, /ticketPanel\.dispose\(\)/u);
});
