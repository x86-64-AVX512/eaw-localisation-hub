import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentHub = fs.readFileSync(path.join(projectRoot, 'apps', 'agent', 'src', 'agent-hub.mjs'), 'utf8');
const reviewApp = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'app.ts'), 'utf8');
const agentIdentity = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'agent-identity.ts'), 'utf8');
const helpPanel = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'help-panel.ts'), 'utf8');
const reviewServer = fs.readFileSync(path.join(projectRoot, 'apps', 'agent', 'src', 'review-server.mjs'), 'utf8');
const ticketPanel = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'ticket-panel.ts'), 'utf8');
const agentConnection = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'agent-connection.ts'), 'utf8');
const documentClose = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'document-close.ts'), 'utf8');
const documentBinding = fs.readFileSync(path.join(projectRoot, 'apps', 'agent', 'src', 'document-binding.mjs'), 'utf8');
const documentLifecycle = fs.readFileSync(path.join(projectRoot, 'apps', 'agent', 'src', 'document-lifecycle.mts'), 'utf8');
const gitHistory = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'git-history-panel.ts'), 'utf8');
const gitHistoryDiffViews = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'git-history-diff-views.ts'), 'utf8');
const historyPanel = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'history-panel.ts'), 'utf8');
const standardDiff = fs.readFileSync(path.join(projectRoot, 'apps', 'review', 'src', 'standard-diff-view.ts'), 'utf8');

test('recovery warning waits for an explicit server-confirmed status', () => {
  assert.match(agentHub, /recoveryStatus: this\.identity\?\.recoveryStatus \?\? ''/u);
  assert.match(reviewApp, /applyAgentIdentity\(state, message\)/u);
  assert.match(agentIdentity, /recoveryStatus: message\.recoveryStatus \?\? ''/u);
  assert.doesNotMatch(agentHub, /this\.identity\?\.recoveryStatus \?\? 'setup_required'/u);
  assert.doesNotMatch(agentIdentity, /message\.recoveryStatus \?\? 'setup_required'/u);
});

test('mandatory training waits for server progress and Review records successful disk writes', () => {
  assert.match(agentHub, /Object\.hasOwn\(identity, 'trainingProgress'\)/u);
  assert.match(agentHub, /trainingProgressConfirmed: this\.identity\?\.trainingProgressConfirmed === true/u);
  assert.match(agentIdentity, /trainingProgressConfirmed: message\.trainingProgressConfirmed === true/u);
  assert.match(helpPanel, /state\.trainingProgressConfirmed === true/u);
  assert.match(reviewServer, /!this\.closed && \(materialisationInvalidated \|\| \(latest !== null && latest !== materialised\)\)/u);
  assert.match(reviewServer, /materialisationSucceeded && !materialisationInvalidated[\s\S]*confirmDiskMaterialisation/u);
});

test('Review waits for its personal projection before accepting the first edit', () => {
  assert.match(documentBinding, /if \(!this\.ticketId && !this\.personalReady\) return;/u);
  assert.doesNotMatch(documentBinding, /client\.kind !== 'review' && !this\.personalReady/u);
});

test('ticket panel retries transient initialisation failures and can recover controls', () => {
  assert.match(ticketPanel, /async function reloadWithRetry\(\)/u);
  assert.match(ticketPanel, /scheduleRetry\(\)/u);
  assert.match(ticketPanel, /setAvailability\(true\)/u);
  assert.match(ticketPanel, /Math\.min\(retryDelay \* 2, 30_000\)/u);
  assert.match(reviewApp, /ticketPanel\.dispose\(\)/u);
});

test('Review starts document connection without waiting for the auxiliary ticket catalog', () => {
  assert.match(reviewApp, /void ticketPanel\.initialise\(\);[\s\S]*agentConnection = createAgentConnection/u);
  assert.doesNotMatch(reviewApp, /await ticketPanel\.initialise/u);
  assert.match(reviewApp, /variants: 'compact-v1'/u);
});

test('ticket navigation closes the active presence before reloading Review', () => {
  assert.match(ticketPanel, /await options\.beforeNavigate\?\.\(\)[\s\S]*location\.reload\(\)/u);
  assert.match(documentClose, /send\(\{type:'deactivate'[\s\S]*send\(\{type:'close'[\s\S]*await connection\(\)\?\.flush/u);
  assert.match(ticketPanel, /embeddedSessionId\(\)[\s\S]*postWorkspace\('navigate'/u);
  const unload = reviewApp.slice(reviewApp.indexOf("window.addEventListener('beforeunload'"));
  assert.ok(unload.indexOf('closeActiveDocument') < unload.indexOf('agentConnection?.dispose()'));
  assert.match(agentConnection, /async function flush\([\s\S]*bufferedAmount/u);
});

test('a deleted ticket releases its tab and redirects only if it is the active document', () => {
  assert.match(documentBinding, /handleUnavailableTicketClose\(this, code, closeReason\)/u);
  assert.match(documentLifecycle, /code !== 1001 \|\| !binding\.ticketId[\s\S]*type: 'ticketUnavailable'/u);
  assert.match(documentLifecycle, /binding\.paused = true/u);
  assert.match(reviewApp, /message\.type === 'ticketUnavailable'[\s\S]*ticketPanel\.leaveUnavailable/u);
  assert.match(ticketPanel, /leaveUnavailable[\s\S]*void navigate\(null,true\)/u);
  const workspace = fs.readFileSync(new URL('../apps/review/src/workspace-window.ts',import.meta.url),'utf8');
  assert.match(workspace, /const wasActive = s === active;[\s\S]*replaceCurrent\) requestClose\(s.tab\);[\s\S]*if \(wasActive\) tabs.open/u);
});

test('closing Git diff retains its warm models but rejects late responses', () => {
  assert.match(gitHistory, /function suspend\(\)[\s\S]*comparisonId \+= 1[\s\S]*loadId \+= 1[\s\S]*diffViews\.suspend\(\)/u);
  assert.match(gitHistory, /dialog\.addEventListener\('cancel', suspend\)/u);
  assert.match(gitHistory, /requestId !== comparisonId \|\| !dialog\.open/u);
  assert.match(gitHistoryDiffViews, /preserveOnDeactivate: true/u);
  assert.match(gitHistoryDiffViews, /MAX_CACHED_PAIRS = 3/u);
  assert.match(standardDiff, /if \(!preserveOnDeactivate\) diff\.setModel\(null\)/u);
  assert.match(standardDiff, /if \(signature === hiddenSignature\) return;/u);
  assert.match(standardDiff, /cancelAnimationFrame\(layoutFrame\)/u);
});

test('closing ticket catalog disposes Monaco and rejects late diff responses', () => {
  assert.match(ticketPanel, /function suspendCatalogDiff\(\)[\s\S]*summaryRequest \+= 1[\s\S]*diffRequest \+= 1[\s\S]*disposeDiff\(\)/u);
  assert.match(ticketPanel, /ticket-catalog-close'\)\.addEventListener\('click', closeCatalog\)/u);
  assert.match(ticketPanel, /catalog\.addEventListener\('close', suspendCatalogDiff\)/u);
  assert.match(ticketPanel, /!catalog\.open \|\| ticket\.id !== selectedId \|\| requestId !== summaryRequest/u);
  assert.match(ticketPanel, /!catalog\.open \|\| ticket\.id !== selectedId \|\| requestId !== diffRequest/u);
});

test('deleting a ticket closes its active diff before waiting on the server', () => {
  const deletion = ticketPanel.slice(ticketPanel.indexOf("requiredButton('#ticket-delete').addEventListener"));
  assert.ok(deletion.includes("method: 'DELETE'"));
  assert.ok(deletion.indexOf('closeCatalog()') < deletion.indexOf("method: 'DELETE'"));
});

test('closing document history detaches Monaco and rejects late versions', () => {
  assert.match(historyPanel, /diffView\.setActive\(false\)/u);
  assert.match(historyPanel, /function closeHistory\(\)[\s\S]*suspendHistory\(\)[\s\S]*dialog\.close\(\)/u);
  assert.match(historyPanel, /history-close'\)\.addEventListener\('click', closeHistory\)/u);
  assert.match(historyPanel, /dialog\.addEventListener\('close', suspendHistory\)/u);
  assert.match(historyPanel, /if \(!dialog\.open \|\| \(message\.id !== selectedId && message\.id !== previousId\)\) return;/u);
});
