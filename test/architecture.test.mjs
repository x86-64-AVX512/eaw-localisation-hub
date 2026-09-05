import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function lineCount(relativePath) {
  return source(relativePath).split(/\r?\n/u).length;
}

test('entrypoints stay coordinators instead of absorbing extracted subsystems', () => {
  const budgets = new Map([
    ['apps/server/src/main.mjs', 450],
    ['apps/agent/src/document-binding.mjs', 550],
    ['apps/server/src/auth.mjs', 600],
    ['apps/review/src/app.js', 300],
    ['apps/review/src/collaboration-panel.js', 220],
    ['apps/review/src/review-cards.js', 190],
    ['plugin/src/EawLocalisationHub.cpp', 2200],
  ]);
  for (const [relativePath, maximumLines] of budgets) {
    assert.ok(
      lineCount(relativePath) <= maximumLines,
      `${relativePath} exceeded its ${maximumLines}-line architecture budget`,
    );
  }
  assert.doesNotMatch(source('apps/server/src/main.mjs'), /class DocumentRoom/u);
  assert.doesNotMatch(source('apps/agent/src/document-binding.mjs'), /function mergeLocalisationThreeWay/u);
});

test('security and collaboration boundaries have dedicated modules', () => {
  const requiredModules = [
    'apps/server/src/auth-model.mjs',
    'apps/server/src/auth-recovery.mjs',
    'apps/server/src/recovery-code.mjs',
    'apps/server/src/protocol-limits.mjs',
    'apps/server/src/document-room.mjs',
    'apps/server/src/room-metadata.mjs',
    'apps/server/src/room-registry.mjs',
    'apps/server/src/ticket-store.mjs',
    'apps/server/src/ticket-http.mjs',
    'apps/server/src/ticket-service.mjs',
    'apps/server/src/git-commit-verifier.mjs',
    'apps/server/src/document-history.mjs',
    'apps/agent/src/document-actions.mjs',
    'apps/agent/src/document-view.mjs',
    'apps/agent/src/disk-reconciliation.mjs',
    'apps/agent/src/personal-document.mjs',
    'apps/agent/src/document-lifecycle.mjs',
    'apps/agent/src/workspace-transition.mjs',
    'apps/agent/src/review-endpoint.mjs',
    'apps/agent/src/local-presence.mjs',
    'apps/review/src/history-panel.js',
    'apps/agent/src/git-ticket-context.mjs',
    'apps/agent/src/git-executable.mjs',
    'apps/agent/src/git-file-history.mjs',
    'apps/agent/src/ticket-workflow.mjs',
    'apps/agent/src/ticket-review-api.mjs',
    'apps/agent/src/key-replacement-workflow.mjs',
    'apps/review/src/collaboration-panel.js',
    'apps/review/src/avatar-profile.js',
    'apps/review/src/avatar-view.js',
    'apps/review/src/editor-decorations.js',
    'apps/review/src/editing-mode.js',
    'apps/review/src/english-original.js',
    'apps/review/src/presence-cursors.js',
    'apps/review/src/presence-controller.js',
    'apps/review/src/review-cards.js',
    'apps/review/src/review-navigation.js',
    'apps/review/src/review-card-elements.js',
    'apps/review/src/recovery-banner.js',
    'apps/review/src/scroll-sync.js',
    'apps/review/src/read-only-review.js',
    'apps/review/src/key-replacement-panel.js',
    'apps/review/src/review-utilities.js',
    'apps/review/src/suggestion-history.js',
    'apps/review/src/ticket-panel.js',
    'apps/review/src/agent-connection.js',
    'apps/review/src/git-conflict-diff.js',
    'apps/review/src/git-conflict-state.js',
    'apps/review/src/git-history-panel.js',
    'apps/review/src/document-variants.js',
    'apps/review/src/remote-document.js',
    'plugin/src/CollaborationOverlays.cpp',
    'plugin/src/EditorInterop.cpp',
    'plugin/src/IpcSecurity.cpp',
    'plugin/src/LegacyIntegrationSettings.cpp',
    'plugin/src/ProtocolMessage.cpp',
  ];
  for (const relativePath of requiredModules) {
    assert.ok(fs.statSync(path.join(projectRoot, relativePath)).isFile(), `${relativePath} is missing`);
  }
});

test('local prototype exercises the production canonical Git path', () => {
  const common = source('scripts/local-prototype-common.ps1');
  const start = source('scripts/start-local-prototype.ps1');
  const gitLab = source('scripts/local-prototype-git.ps1');
  const launcher = source('scripts/launch-local-prototype-ui.ps1');
  assert.match(common, /GitOriginDirectory/u);
  assert.match(start, /EAW_HUB_CANONICAL_REPOSITORY/u);
  assert.match(start, /local-prototype-git\.ps1'\) -Action Prepare/u);
  assert.match(gitLab, /'localisation\\replace'/u,
    'the canonical probe must also cover localisation/replace');
  assert.match(gitLab, /'pull', '--ff-only'/u,
    'updating a test participant must never overwrite local work');
  assert.match(launcher, /Invoke-GitLabAction 'Publish'/u);
  assert.match(launcher, /Invoke-GitLabAction 'SyncA'/u);
  assert.match(launcher, /Invoke-GitLabAction 'SyncB'/u);
});

test('Review owns the complete collaboration UI while the Notepad++ client is marked Legacy', () => {
  const reviewSources = [
    'apps/review/src/app.js',
    'apps/review/src/collaboration-panel.js',
    'apps/review/src/editing-mode.js',
    'apps/review/src/review-cards.js',
    'apps/review/src/avatar-profile.js',
    'apps/review/src/recovery-banner.js',
  ].map(source).join('\n');
  for (const command of [
    'undo', 'redo', 'reservationCreate', 'reservationDeleteAt', 'reservationDelete',
    'commentCreate', 'commentReply', 'commentStatus', 'commentDelete',
    'suggestionCreate', 'suggestionUpdate', 'suggestionReply', 'suggestionAccept', 'suggestionReject',
    'suggestionDelete', 'avatarSet', 'avatarDelete', 'recoveryIssue', 'recoveryConfirm',
    'recoveryDiscard', 'externalConflictResolve',
  ]) {
    assert.match(reviewSources, new RegExp(`['\"]${command}['\"]`, 'u'), `${command} is absent from Review`);
  }
  assert.match(source('README.md'), /Notepad\+\+-плагин переведён в режим Legacy/u);
  assert.match(source('plugin/src/EawLocalisationHub.cpp'), /Legacy-панель совместной работы/u);
  assert.match(source('apps/review/src/presence-controller.js'), /setInterval\(publish, HEARTBEAT_MILLISECONDS\)/u);
  assert.match(source('apps/review/src/app.js'), /encodeBase64, utf16ToByte/u,
    'Review selection commands must import their UTF-8 offset converter');
  const cursorLayer = source('apps/review/src/presence-cursors.js');
  assert.match(cursorLayer, /addContentWidget/u,
    'Review caret must use a non-layout-shifting Monaco content widget');
  assert.match(cursorLayer, /ContentWidgetPositionPreference\.EXACT/u,
    'Review caret must be anchored at the exact Monaco column');
});

test('Legacy suggestion display uses a product-neutral name', () => {
  const plugin = source('plugin/src/EawLocalisationHub.cpp');
  assert.match(plugin, /Карточки у текста/u);
  assert.doesNotMatch(plugin, /Как в Google Docs/u);
});

test('Legacy plugin backs off while the Desktop Agent pipe is absent', () => {
  const plugin = source('plugin/src/EawLocalisationHub.cpp');
  const connectionLoop = plugin.slice(
    plugin.indexOf('if (!WaitNamedPipeW'),
    plugin.indexOf('EnterCriticalSection(&g_pipeLock)', plugin.indexOf('if (!WaitNamedPipeW')),
  );
  assert.match(connectionLoop, /WaitForSingleObject\(g_stopEvent, 250\)/u,
    'a missing named pipe must not cause an unbounded busy loop');
  assert.match(connectionLoop, /pipe == INVALID_HANDLE_VALUE[\s\S]*WaitForSingleObject\(g_stopEvent, 100\)/u,
    'a pipe-open race must also have a stop-aware retry delay');
});

test('Legacy plugin is inert by default and can be enabled explicitly', () => {
  const plugin = source('plugin/src/EawLocalisationHub.cpp');
  const settings = source('plugin/src/LegacyIntegrationSettings.cpp');
  const ready = plugin.slice(
    plugin.indexOf('notification->nmhdr.code == NPPN_READY'),
    plugin.indexOf('notification->nmhdr.code == NPPN_BUFFERACTIVATED'),
  );
  assert.match(settings, /GetPrivateProfileIntW\(kSection, kEnabled, 0/u,
    'a missing setting must keep the Legacy integration disabled');
  assert.match(ready, /LegacyIntegrationSettings::Load/u);
  assert.match(ready, /if \(g_integrationEnabled\) SetIntegrationEnabled\(true, false\)/u,
    'Notepad++ startup must not start IPC when the opt-in is absent');
  assert.match(plugin, /Включить интеграцию с Agent/u);
  assert.match(plugin, /if \(!g_integrationEnabled\) return;/u,
    'editor notifications must be ignored while Legacy integration sleeps');
  const reviewOpenStart = plugin.lastIndexOf('void OpenReviewApplication()');
  const reviewOpen = plugin.slice(reviewOpenStart, plugin.indexOf('void ShowConnectionStatus()', reviewOpenStart));
  assert.match(reviewOpen, /g_pendingReviewPath = pathUtf8; StartTransport\(true\)/u,
    'opening Review must establish a transport-only connection without waking editor integration');
  assert.match(plugin, /void StartTransport\(bool reviewOnly = false\)[\s\S]*if \(!reviewOnly\) \{[\s\S]*SetWindowSubclass\(g_nppData\._scintillaMainHandle/u,
    'a Review-only connection must not install Scintilla hooks');
});

test('Legacy plugin IPC protocol comes from the shared build constant', () => {
  const build = source('scripts/build-plugin.mjs');
  const plugin = source('plugin/src/EawLocalisationHub.cpp');
  assert.match(build, /import \{ PROTOCOL_VERSION \} from '\.\.\/packages\/shared\/src\/constants\.mjs'/u);
  assert.match(build, /`-DEAW_HUB_PROTOCOL_VERSION=\$\{PROTOCOL_VERSION\}`/u);
  assert.match(plugin, /constexpr std::int64_t kProtocolVersion = EAW_HUB_PROTOCOL_VERSION/u);
  assert.match(plugin, /message\.Integer\("protocol", 0\) != kProtocolVersion/u);
  assert.match(plugin, /std::to_string\(kProtocolVersion\)/u);
  assert.doesNotMatch(plugin, /message\.Integer\("protocol", 0\) != \d+/u);
});

test('Legacy plugin does not publish document events before IPC is ready', () => {
  const plugin = source('plugin/src/EawLocalisationHub.cpp');
  const writer = plugin.slice(
    plugin.indexOf('void WritePipeLine(const std::string& message, bool priority)'),
    plugin.indexOf('void SetIndicatorStyle'),
  );
  assert.match(writer, /!priority[\s\S]*!g_ipcAuthenticated\.load\(\)[\s\S]*!g_lifecycle\.Connected\(\)/u);
  assert.match(plugin, /type == "ipcChallenge"[\s\S]*g_outbound\.clear\(\)[\s\S]*g_ipcAuthenticated\.store\(true\)/u);
  assert.match(plugin, /g_ipcAuthenticated\.store\(false\)[\s\S]*g_outbound\.clear\(\)[\s\S]*g_pipe = pipe/u);
});

test('Legacy plugin waits for the active document generation before publishing edits', () => {
  const plugin = source('plugin/src/EawLocalisationHub.cpp');
  const closeStart = plugin.lastIndexOf('void CloseDocument(UINT_PTR bufferId)');
  const closeDocument = plugin.slice(
    closeStart,
    plugin.indexOf('void PollCurrentDocument()', closeStart),
  );
  const pollStart = plugin.lastIndexOf('void PollCurrentDocument()');
  const pollDocument = plugin.slice(
    pollStart,
    plugin.indexOf('void ScheduleAutoSave', pollStart),
  );
  const sendEdit = plugin.slice(
    plugin.indexOf('void SendEdit(const SCNotification* notification)'),
    plugin.indexOf('void SendCursor(bool force)'),
  );
  assert.match(closeDocument, /g_lifecycle\.DocumentClosed\(\)/u,
    'closing the current buffer must invalidate its ready state');
  assert.match(closeDocument, /g_currentDocumentPath\.clear\(\)/u,
    'reopening the same path must create a new document generation');
  assert.match(pollDocument, /normalisedPath != g_currentDocumentPath[\s\S]*SendCurrentDocument\(\)/u,
    'polling must register a switched buffer before considering snapshots');
  assert.match(pollDocument, /!g_lifecycle\.Ready\(\)/u,
    'polling must not publish snapshots before documentReady');
  assert.match(sendEdit, /!g_lifecycle\.Ready\(\)/u,
    'Scintilla notifications must not publish edits before documentReady');
  assert.match(sendEdit, /normalisedPath != g_currentDocumentPath/u,
    'late notifications from another buffer generation must be ignored');
});

test('Agent tolerates late document events after a plugin buffer closes', () => {
  const hub = source('apps/agent/src/agent-hub.mjs');
  assert.match(hub, /\['activate', 'deactivate', 'cursor', 'close', 'edit', 'snapshot'\]\.includes/u);
  assert.doesNotMatch(source('apps/agent/src/document-binding.mjs'), /Document is not synchronised yet/u);
});

test('Agent opens Review without requiring the sleeping Legacy client to bind the document', () => {
  const hub = source('apps/agent/src/agent-hub.mjs');
  const directOpen = hub.slice(
    hub.indexOf("if (message.type === 'reviewOpen')"),
    hub.indexOf('const state = client.documents.get(absolutePath)'),
  );
  assert.match(directOpen, /normaliseTrackedPath\(this\.options\.repo, absolutePath\)/u,
    'the direct command must retain repository containment checks');
  assert.match(directOpen, /this\.options\.reviewOpen\?\.\(absolutePath\)/u);
  assert.match(directOpen, /return;/u,
    'reviewOpen must be handled before the document binding requirement');
});

test('Legacy plugin leaves native undo shortcuts to Notepad++', () => {
  const plugin = source('plugin/src/EawLocalisationHub.cpp');
  const scintillaSubclass = plugin.slice(
    plugin.indexOf('LRESULT CALLBACK ScintillaSubclassProcedure'),
    plugin.indexOf('void DeleteReservationAtCaret'),
  );
  assert.doesNotMatch(scintillaSubclass, /WM_KEYDOWN[\s\S]*CollaborativeUndo/u);
  assert.match(plugin, /g_undoShortcut\{true, true, false, 'Z'\}/u);
  assert.match(plugin, /g_redoShortcut\{true, true, false, 'Y'\}/u);
  assert.match(plugin, /ApplyRemoteReplace[\s\S]*SCI_SETUNDOCOLLECTION, TRUE[\s\S]*SCI_EMPTYUNDOBUFFER/u);
  assert.match(plugin, /diskSynchronized[\s\S]*SCI_SETSAVEPOINT[\s\S]*!diskSynchronized[\s\S]*ScheduleAutoSave/u,
    'a branch checkout already present on disk must not be saved back by Notepad++');
});

test('inline suggestion editing validates the canonical range before projecting text', () => {
  const editing = source('apps/review/src/editing-mode.js');
  const app = source('apps/review/src/app.js');
  const block = editing.slice(
    editing.indexOf('function editSuggestion'),
    editing.indexOf('const contentSubscription'),
  );
  assert.match(block, /byteToUtf16/u);
  assert.match(block, /baseText\.slice\(start, end\) !== original/u);
  assert.match(block, /state\.applyingRemote = true[\s\S]*pushEditOperations/u);
  assert.match(block, /type: 'suggestionUpdate'/u);
  assert.match(app, /state\.editingSuggestionId \|\| !editingMode\.isSuggesting\(\)/u,
    'ordinary editing mode must not reopen a suggestion merely because it was clicked');
});

test('suggestion typing is not split by an idle finalisation timer', () => {
  const editing = source('apps/review/src/editing-mode.js');
  assert.doesNotMatch(editing, /SUGGESTION_IDLE|setTimeout\(flushSuggestion/u);
});

test('Review keeps inserted and deleted suggestion text visible without hover', () => {
  const decorations = source('apps/review/src/editor-decorations.js');
  assert.match(decorations, /const activeProjection = state\.suggestionProjection/u);
  assert.match(decorations, /suggestionTraceParts\(original, replacement, activeProjection\.traceJson\)/u);
  assert.match(decorations, /before: \{ content: part\.text, inlineClassName: strikeClass \}/u);
  assert.match(decorations, /inlineClassName: replacementClass/u);
  assert.doesNotMatch(decorations, /[бБ]ыло:|стало:/u);
  assert.match(decorations, /part\.kind === 'delete' && !part\.text\.includes\('\\n'\)/u,
    'only actually deleted text must remain as struck injected text');
  assert.match(decorations, /changeViewZones[\s\S]*active-suggestion-original-zone/u,
    'a multiline original must use a view zone instead of invalid multiline injected text');
  assert.match(decorations, /showIfCollapsed: true/u,
    'a zero-width insertion must be rendered even when its Monaco range is collapsed');
  assert.doesNotMatch(decorations, /before: original && replacement/u,
    'a completed replacement must be displayed after its struck original');
});

test('Review lane keeps every card in a scrollable vertical list', () => {
  const cards = source('apps/review/src/review-cards.js');
  const styles = source('apps/review/src/style.css');
  assert.doesNotMatch(cards, /top \+ card\.offsetHeight|card\.classList\.add\('hidden'\)/u);
  assert.match(styles, /#review-lane[\s\S]*overflow-y: auto/u);
  assert.match(styles, /#cards[\s\S]*flex-direction: column/u);
  assert.match(styles, /\.comparison \.empty-marker[\s\S]*white-space: nowrap/u,
    'the insertion/deletion marker must never collapse into a vertical word');
  assert.match(cards, /visibleComparisonText\(part\.text\)/u,
    'a newline-only suggestion must not render as an empty card');
});

test('Review collaboration sections scroll instead of overlapping at short window heights', () => {
  const styles = source('apps/review/src/style.css');
  assert.match(styles, /\.workspace \{[\s\S]*grid-template-rows: minmax\(0, 1fr\)[\s\S]*overflow: hidden/u);
  const lane = styles.slice(styles.indexOf('#collaboration-lane {'), styles.indexOf('.section-heading'));
  assert.match(lane, /#collaboration-lane[\s\S]*overflow-y: auto/u);
  assert.match(lane, /#collaboration-lane[\s\S]*min-height: 0/u);
  assert.match(lane, /\.side-section \{ flex: 0 0 auto/u);
  assert.match(lane, /\.conflicts-section \{ min-height: 155px; flex: 1 0 155px/u);
});

test('Review header grows when its actions wrap instead of clipping the ticket switcher', () => {
  const styles = source('apps/review/src/style.css');
  assert.match(styles, /grid-template-areas: "brand actions" "status status"/u);
  assert.match(styles, /\.appbar \{[\s\S]*align-items: start/u);
  assert.match(styles, /\.appbar \{[\s\S]*flex: 0 0 auto/u);
});

test('personal file controls live in an on-demand dialog instead of a permanent notice', () => {
  const markup = source('apps/review/src/index.html');
  const variants = source('apps/review/src/document-variants.js');
  assert.match(markup, /id="personal-file-open"/u);
  assert.match(markup, /<dialog id="personal-file-dialog"/u);
  assert.doesNotMatch(markup, /id="personal-file-notice"/u);
  assert.match(variants, /openButton\.addEventListener\('click', \(\) => dialog\.showModal\(\)\)/u);
});

test('Review updates its document context and becomes read-only while Git switches branches', () => {
  const app = source('apps/review/src/app.js');
  const handler = app.slice(app.indexOf("message.type === 'workspaceChanged'"), app.indexOf("message.type === 'error'"));
  assert.match(handler, /#document-name/u);
  assert.match(handler, /state\.ready = false/u);
  assert.match(handler, /readOnly: true/u);
});

test('Agent never treats an unavailable Git result as a branch switch', () => {
  const hub = source('apps/agent/src/agent-hub.mjs');
  const current = hub.slice(hub.indexOf('currentGitWorkspace()'), hub.indexOf('currentGitCommit()'));
  const changeStart = hub.lastIndexOf('  checkWorkspaceChange(');
  const change = hub.slice(changeStart, hub.indexOf('  receivePluginMessage(', changeStart));
  assert.match(current, /return '';/u);
  assert.doesNotMatch(current, /unknown/u);
  assert.match(change, /if \(!workspace \|\| workspace === this\.options\.workspace\)/u);
  assert.match(change, /this\.workspaceObservationCount < 2/u);
});

test('Git history, document history, and localisation audit share the compact wrapped diff view', () => {
  const history = source('apps/review/src/git-history-panel.js');
  const documentHistory = source('apps/review/src/history-panel.js');
  const audit = source('apps/review/src/localisation-audit-panel.js');
  const standard = source('apps/review/src/standard-diff-view.js');
  const style = source('apps/review/src/style.css');
  for (const consumer of [history, documentHistory, audit]) {
    assert.match(consumer, /createStandardDiffView/u);
  }
  assert.match(standard, /wordWrapOverride1: 'on'/u);
  assert.match(standard, /wordWrapOverride2: 'on'/u);
  assert.match(standard, /hideUnchangedRegions: \{ enabled: false \}/u);
  assert.match(standard, /diff\.onDidUpdateDiff\(showChangedRegionsOnly\)/u);
  assert.match(standard, /setHiddenAreas\(hiddenRanges/u);
  assert.match(standard, /requestAnimationFrame\(\(\) => \{ diff\.layout\(\); enforceOptions\(\); showChangedRegionsOnly\(\); \}\)/u);
  assert.match(style, /\.standard-diff \.diagonal-fill/u);
  assert.match(style, /background-image: none !important/u);
});

test('English original uses one reusable foreground native window', () => {
  const host = source('apps/review-host/src/main.cpp');
  assert.match(host, /kEnglishWindowTitle/u);
  assert.match(host, /readOnly=english/u);
  assert.match(host, /kEnglishMutexName/u);
  assert.match(host, /FindWindowW\(kWindowClass, kEnglishWindowTitle\)/u);
  assert.match(host, /SendMessageTimeoutW\(window, WM_COPYDATA/u);
  assert.match(host, /case WM_COPYDATA/u);
  assert.match(host, /g_webview->Navigate\(g_url\.c_str\(\)\)/u);
  assert.match(host, /SetWindowPos\(window, HWND_TOPMOST/u);
});
