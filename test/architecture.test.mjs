import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

// Budgets count non-whitespace characters, not lines: joining statements onto
// one line must not make room for new code. Each value is the former line
// budget converted at the file's own characters-per-line in 0.8.8F8.
function codeSize(relativePath) {
  return source(relativePath).replace(/\s+/gu, '').length;
}

test('entrypoints stay coordinators instead of absorbing extracted subsystems', () => {
  const budgets = new Map([
    ['apps/server/src/main.mjs', 16_300],
    ['apps/agent/src/document-binding.mjs', 17_000],
    ['apps/server/src/auth.mjs', 19_700],
    ['apps/review/src/app.ts', 18_100],
    ['apps/review/src/collaboration-panel.ts', 9_050],
    ['apps/review/src/review-cards.ts', 8_700],
  ]);
  for (const [relativePath, maximumCharacters] of budgets) {
    assert.ok(
      codeSize(relativePath) <= maximumCharacters,
      `${relativePath} exceeded its ${maximumCharacters}-character architecture budget; extract a module instead of packing lines`,
    );
  }
  assert.doesNotMatch(source('apps/server/src/main.mjs'), /class DocumentRoom/u);
  assert.doesNotMatch(source('apps/agent/src/document-binding.mjs'), /function mergeLocalisationThreeWay/u);
});

test('security and collaboration boundaries have dedicated modules', () => {
  const requiredModules = [
    'apps/server/src/auth-model.mjs',
    'apps/server/src/auth-recovery.mjs',
    'apps/server/src/auth-spelling.mjs',
    'apps/server/src/recovery-code.mjs',
    'apps/server/src/protocol-limits.mts',
    'apps/server/src/document-socket.mts',
    'apps/server/src/document-room.mjs',
    'apps/server/src/room-metadata.mjs',
    'apps/server/src/reservation-update.mjs',
    'apps/server/src/room-registry.mjs',
    'apps/server/src/ticket-store.mjs',
    'apps/server/src/ticket-http.mjs',
    'apps/server/src/ticket-service.mjs',
    'apps/server/src/spelling-dictionary.mjs',
    'apps/server/src/spelling-dictionary-worker.mjs',
    'apps/server/src/spelling-http.mjs',
    'apps/server/src/git-commit-verifier.mjs',
    'apps/server/src/document-history.mjs',
    'apps/agent/src/document-actions.mjs',
    'apps/agent/src/document-server-messages.mjs',
    'apps/agent/src/document-view.mjs',
    'apps/agent/src/disk-reconciliation.mjs',
    'apps/agent/src/personal-document.mjs',
    'apps/agent/src/document-lifecycle.mts',
    'apps/agent/src/workspace-transition.mjs',
    'apps/agent/src/review-endpoint.mts',
    'apps/agent/src/local-presence.mts',
    'apps/review/src/history-panel.ts',
    'apps/agent/src/git-ticket-context.mts',
    'apps/agent/src/git-executable.mts',
    'apps/agent/src/git-file-history.mts',
    'apps/agent/src/ticket-workflow.mjs',
    'apps/agent/src/ticket-review-api.mjs',
    'apps/agent/src/key-replacement-workflow.mjs',
    'apps/review/src/collaboration-panel.ts',
    'apps/review/src/collaboration-messages.ts',
    'apps/review/src/list-items.ts',
    'apps/review/src/reservation-editor.ts',
    'packages/shared/src/localisation-keys.mts',
    'apps/review/src/avatar-profile.ts',
    'apps/review/src/avatar-view.ts',
    'apps/review/src/editor-decorations.ts',
    'apps/review/src/editor-settings.ts',
    'apps/review/src/spellcheck.ts',
    'apps/review/src/spellcheck-worker.ts',
    'packages/shared/src/spelling-issues.mts',
    'packages/shared/src/spelling-bloom.mts',
    'apps/review/src/workspace-tabs.ts',
    'apps/review/src/editing-mode.ts',
    'apps/review/src/english-original.ts',
    'apps/review/src/presence-cursors.ts',
    'apps/review/src/presence-controller.ts',
    'apps/review/src/review-cards.ts',
    'apps/review/src/comment-actions.ts',
    'apps/review/src/review-card-layout.ts',
    'apps/review/src/review-navigation.ts',
    'apps/review/src/review-card-elements.ts',
    'apps/review/src/recovery-banner.ts',
    'apps/review/src/scroll-sync.ts',
    'apps/review/src/read-only-review.ts',
    'apps/review/src/key-replacement-panel.ts',
    'apps/review/src/review-utilities.ts',
    'apps/review/src/suggestion-history.ts',
    'apps/review/src/ticket-panel.ts',
    'apps/review/src/appbar-layout.ts',
    'apps/review/src/agent-connection.ts',
    'apps/review/src/git-conflict-diff.ts',
    'apps/review/src/git-conflict-state.ts',
    'apps/review/src/git-history-panel.ts',
    'apps/review/src/document-variants.ts',
    'apps/review/src/remote-document.ts',
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

test('Review owns the complete collaboration UI without a native editor plugin', () => {
  const reviewSources = [
    'apps/review/src/app.ts',
    'apps/review/src/comment-actions.ts',
    'apps/review/src/collaboration-panel.ts',
    'apps/review/src/editing-mode.ts',
    'apps/review/src/review-cards.ts',
    'apps/review/src/avatar-profile.ts',
    'apps/review/src/recovery-banner.ts',
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
  assert.match(source('apps/review/src/presence-controller.ts'), /setInterval\(publish, HEARTBEAT_MILLISECONDS\)/u);
  assert.match(source('apps/review/src/editor-coordinates.ts'), /byteToUtf16, utf16ToByte/u,
    'Review coordinate commands must import their UTF-8 offset converters');
  assert.match(source('apps/review/src/app.ts'), /positionByteAt,/u,
    'Review navigation must use the dedicated coordinate converter');
  const cursorLayer = source('apps/review/src/presence-cursors.ts');
  assert.match(cursorLayer, /addContentWidget/u,
    'Review caret must use a non-layout-shifting Monaco content widget');
  assert.match(cursorLayer, /ContentWidgetPositionPreference\.EXACT/u,
    'Review caret must be anchored at the exact Monaco column');
});

test('standalone Review has no Notepad++ bridge or plugin build', () => {
  for (const directory of ['plugin/src', 'plugin/resource']) {
    const absolute = path.join(projectRoot, directory);
    assert.ok(!fs.existsSync(absolute) || fs.readdirSync(absolute).length === 0);
  }
  assert.doesNotMatch(source('apps/agent/src/main.mjs'), /namedPipePath|createServer\(\(socket\)/u);
  assert.doesNotMatch(source('package.json'), /build:plugin|test:plugin/u);
  assert.doesNotMatch(source('installer/EaWLocalisationHub.iss'), /notepad\+\+|EawLocalisationHub\.dll/iu);
});
test('inline suggestion editing validates the canonical range before projecting text', () => {
  const editing = source('apps/review/src/editing-mode.ts');
  const app = source('apps/review/src/app.ts');
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
  const editing = source('apps/review/src/editing-mode.ts');
  assert.doesNotMatch(editing, /SUGGESTION_IDLE|setTimeout\(flushSuggestion/u);
});

test('Review keeps inserted and deleted suggestion text visible without hover', () => {
  const decorations = source('apps/review/src/editor-decorations.ts');
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

test('Review lane anchors cards beside their text and resolves vertical collisions', () => {
  const cards = source('apps/review/src/review-cards.ts');
  const layout = source('apps/review/src/review-card-layout.ts');
  const styles = source('apps/review/src/style.css');
  assert.match(layout, /desiredTop: editor\.getTopForLineNumber/u);
  assert.match(layout, /nextTop = top \+ height \+ 8/u);
  assert.match(layout, /requestAnimationFrame\(performLayout\)/u,
    'multiple scroll and collaboration updates share one layout frame');
  assert.match(styles, /#review-lane[\s\S]*overflow-y: auto/u);
  assert.match(styles, /#cards[\s\S]*position: relative/u);
  assert.match(styles, /\.review-card[\s\S]*position: absolute/u);
  assert.match(styles, /\.comparison \.empty-marker[\s\S]*white-space: nowrap/u,
    'the insertion/deletion marker must never collapse into a vertical word');
  assert.match(cards, /visibleComparisonText\(part\.text\)/u,
    'a newline-only suggestion must not render as an empty card');
});

test('Review editor preferences and spelling remain explicit user-controlled aids', () => {
  const markup = source('apps/review/src/index.html');
  const settings = source('apps/review/src/editor-settings.ts');
  const spelling = source('apps/review/src/spellcheck.ts');
  const spellingWorker = source('apps/review/src/spellcheck-worker.ts');
  const spellingHttp = source('apps/server/src/spelling-http.mjs');
  const spellingDictionary = source('apps/server/src/spelling-dictionary.mjs');
  const styles = source('apps/review/src/style.css');
  assert.match(markup, /id="editor-theme"/u);
  for (const theme of ['midnight', 'plum', 'forest', 'sepia']) {
    assert.match(markup, new RegExp(`<option value="${theme}">`, 'u'));
    assert.match(settings, new RegExp(`  ${theme}: \\{`, 'u'));
  }
  assert.match(settings, /THEME_IDS\.has\(theme\.value\)/u);
  assert.match(markup, /id="editor-font-family"/u);
  assert.match(markup, /id="spellcheck-enabled"/u);
  assert.match(settings, /localStorage\.setItem/u);
  assert.match(spelling, /registerCodeActionProvider/u);
  assert.match(spelling, /kind: 'quickfix'/u);
  assert.match(spelling, /editor\.action\.quickFix/u);
  assert.match(spelling, /KeyCode\.Period/u);
  assert.match(spelling, /browserEvent[\s\S]*key\.key !== '\.'/u,
    'the quick-fix shortcut must also work when a non-English layout reports another physical key');
  assert.match(spelling, /MAX_CHECKED_LINES = 240/u);
  assert.match(spelling, /\/api\/spelling\/dictionary/u);
  assert.match(spelling, /общий словарь сервера/u);
  assert.match(spelling, /new Worker\('\/spellcheck-worker\.js'/u);
  assert.match(spelling, /start\(\)[\s\S]*started = true[\s\S]*schedule\(\)/u,
    'spellcheck must wait until the collaborative document is ready');
  assert.match(source('apps/review/src/app.ts'), /documentReady[\s\S]*spellcheck\.start\(\)/u);
  assert.doesNotMatch(spelling, /onDidChangeModelContent\([^)]*clear/u,
    'typing must keep the previous markers visible until the replacement result is ready');
  assert.doesNotMatch(spelling, /onDidScrollChange[\s\S]{0,240}clear\(\)/u,
    'scrolling must not flash markers while the next viewport check is pending');
  assert.match(spellingWorker, /spellingIssues/u);
  assert.match(spellingWorker, /checker\.suggest/u);
  assert.match(spellingWorker, /new TextDecoder\('utf-8'\)[\s\S]*nspell\(\{ aff: decodeBase64Text/u,
    'nspell dictionaries must be decoded as text so browser suggestions are not silently empty');
  assert.match(spelling, /createDecorationsCollection/u);
  assert.match(spelling, /onMouseDown[\s\S]*rightButton/u);
  assert.match(spelling, /addAction\([\s\S]*Добавить слово в общий словарь/u);
  assert.match(spelling, /addAction\([\s\S]*Открыть быстрые исправления/u);
  assert.match(spelling, /Открыть быстрые исправления[\s\S]*openQuickFixPanel\(issue\)/u,
    'the context action must open the application-owned quick-fix panel');
  assert.match(spelling, /button\.addEventListener\('click', \(\) => replaceIssue\(issue, suggestion\)\)/u,
    'a replacement must run only after the user chooses that suggestion');
  assert.doesNotMatch(spelling, /setModelMarkers|hoverMessage/u,
    'spelling underlines must not open anything on pointer hover');
  assert.match(styles, /\.spelling-error[\s\S]*text-decoration-style: wavy/u);
  assert.match(styles, /\.spelling-quick-fix-panel[\s\S]*position: fixed/u);
  assert.match(spellingDictionary, /new Worker/u,
    'building the large supplemental dictionary must not block authentication or document sockets');
  assert.doesNotMatch(spellingHttp, /body\.text|spellingIssues|suggestRussianSpelling/u,
    'the server must distribute dictionaries, not process user documents');
  assert.doesNotMatch(source('apps/review/src/app.ts'), /KeyCode\.(?:Equal|NumpadAdd)/u,
    'the application zoom shortcut must remain available');
});

test('Review suppresses ambiguous Unicode boxes in every editor while retaining invisible-character warnings', () => {
  for (const file of [
    'apps/review/src/app.ts',
    'apps/review/src/standard-diff-view.ts',
    'apps/review/src/ticket-panel.ts',
    'apps/review/src/git-conflict-diff.ts',
  ]) {
    assert.match(source(file), /unicodeHighlight:\s*\{\s*ambiguousCharacters:\s*false,\s*invisibleCharacters:\s*true\s*\}/u, file);
  }
});

test('Review hides the Git conflict section unless unresolved conflicts exist', () => {
  const markup = source('apps/review/src/index.html');
  const panel = source('apps/review/src/collaboration-panel.ts');
  const styles = source('apps/review/src/style.css');
  assert.match(markup, /class="side-section conflicts-section" hidden/u,
    'the empty section must not flash while Review is loading');
  assert.match(panel, /conflictSection\.hidden = values\.length === 0/u);
  assert.doesNotMatch(panel, /emptyList\(conflictList, 'Конфликтов нет\.'/u);
  assert.match(styles, /\.conflicts-section\[hidden\] \{ display: none; \}/u,
    'the flex display rule must not override the hidden attribute');
});

test('Review workspace tabs persist document position and the launcher restores the last file', () => {
  const tabs = source('apps/review/src/workspace-tabs.ts');
  const launcher = source('scripts/start-hub.ps1');
  const cmd = source('Launch EaW Hub Review.cmd');
  assert.match(tabs, /eaw-hub-workspace-tabs-v1/u);
  assert.match(tabs, /line: position\.lineNumber/u);
  assert.match(tabs, /scrollTop: editor\.getScrollTop\(\)/u);
  assert.match(tabs, /\/api\/localisation-files/u);
  assert.match(launcher, /last-review\.json/u);
  assert.match(launcher, /Launch EaW Hub Agent\.cmd/u);
  assert.match(cmd, /start-hub\.ps1/u);
});

test('Review collaboration sections scroll instead of overlapping at short window heights', () => {
  const styles = source('apps/review/src/style.css');
  assert.match(styles, /\.workspace \{[\s\S]*grid-template-rows: minmax\(0, 1fr\)[\s\S]*overflow: hidden/u);
  const lane = styles.slice(styles.indexOf('#collaboration-lane {'), styles.indexOf('.section-heading'));
  assert.match(lane, /#collaboration-lane[\s\S]*overflow-y: auto/u);
  assert.match(lane, /#collaboration-lane[\s\S]*min-height: 0/u);
  assert.match(lane, /\.side-section \{ flex: 0 0 auto/u);
  assert.match(lane, /\.reservations-section \{[\s\S]*min-height: 330px[\s\S]*overflow: hidden/u);
  assert.match(styles, /#reservation-list \{[^}]*overflow-y: auto/u);
});

test('Review workbench keeps menus, a wrapping toolbar and shared tabs aligned above the editor', () => {
  const styles = source('apps/review/src/style.css');
  const layout = source('apps/review/src/appbar-layout.ts');
  const markup = source('apps/review/src/index.html');
  const shell = source('apps/review/src/workspace-window.ts');
  assert.match(styles, /\.review-workbench \.actions \{[^}]*flex-wrap:wrap/u);
  assert.match(styles, /\.embedded-document-tools \{ flex:0 0 35px/u);
  assert.match(styles, /\.workspace-window > \.document-tabs \{[^}]*position:absolute/u);
  assert.ok(markup.indexOf('class="actions"') < markup.indexOf('id="document-tabs"'));
  assert.match(markup, /<footer class="review-statusbar">/u);
  assert.match(layout, /postWorkspace\('layout',layout\)/u);
  assert.match(layout, /target && !target.disabled && !target.hidden/u,
    'menu proxies must never bypass disabled collaboration actions');
  assert.match(layout, /signature !== lastLayout/u, 'unchanged layout must not flood the workspace bridge');
  assert.match(layout, /document.querySelector\('dialog\[open\]'\)/u);
  assert.match(shell, /if \(picker.open\) return/u, 'file shortcuts must not close a document behind a modal');
  assert.match(shell, /document.addEventListener\('keydown',shortcuts\)/u,
    'file shortcuts must also work when the shared tab strip owns keyboard focus');
  assert.match(shell, /data.operation === 'layout' && s === active/u);
  assert.match(shell, /bar.classList.toggle\('occluded',Boolean\(data.overlay\)\)/u,
    'child menus and modals must paint above the cross-document tab bar');
  assert.match(layout, /new ResizeObserver\(refresh\)/u);
});

test('personal file controls expose per-key gutter and dialog selection with a visible warning', () => {
  const markup = source('apps/review/src/index.html');
  const variants = source('apps/review/src/document-variants.ts');
  const hub = source('apps/agent/src/agent-hub.mjs');
  assert.match(markup, /id="personal-file-open"/u);
  assert.match(markup, /<dialog id="personal-file-dialog"/u);
  assert.match(markup, /id="local-file-notice"/u);
  assert.match(markup, /id="personal-file-selections"/u);
  assert.match(variants, /openButton\.addEventListener\('click', openDialog\)/u);
  assert.match(variants, /editor\.getValue\(\) === text/u,
    'an unchanged personal-file preview must not flush the Monaco model');
  assert.match(variants, /renderSelections\(true\)[\s\S]*renderConflicts\(true\)[\s\S]*dialog\.showModal\(\)/u,
    'the local-file dialog must render its current contents before opening');
  assert.match(variants, /type: 'personalFileSelectionSet'/u);
  assert.match(variants, /checkbox\.addEventListener\('change'/u);
  assert.match(variants, /GUTTER_GLYPH_MARGIN/u);
  assert.match(variants, /isWholeLine: false/u,
    'one local-file glyph must belong to one model line, not every visual wrap row');
  assert.doesNotMatch(variants, /isWholeLine: true/u);
  assert.match(variants, /classList\?\.contains\('local-file-check'\)/u,
    'clicking another Monaco gutter decoration must not toggle local-file selection');
  assert.match(hub, /message\.type === 'personalFileSelectionSet'/u);
  assert.match(hub, /reviewContentMutations[\s\S]*setPersonalMaterialisation\('mine', absolutePath\)/u,
    'a content-changing Review action must resume personal-file materialisation');
});

test('Review updates its document context and becomes read-only while Git switches branches', () => {
  const app = source('apps/review/src/app.ts');
  const handler = app.slice(app.indexOf("message.type === 'workspaceChanged'"), app.indexOf("message.type === 'error'"));
  assert.match(handler, /#document-name/u);
  assert.match(handler, /state\.ready = false/u);
  assert.match(handler, /readOnly: true/u);
});

test('Agent never treats an unavailable Git result as a branch switch', () => {
  const hub = source('apps/agent/src/agent-hub.mjs');
  const current = hub.slice(hub.indexOf('currentGitWorkspace()'), hub.indexOf('currentGitCommit()'));
  const changeStart = hub.lastIndexOf('  checkWorkspaceChange(');
  const change = hub.slice(changeStart, hub.indexOf('  receiveClientMessage(', changeStart));
  assert.match(current, /return '';/u);
  assert.doesNotMatch(current, /unknown/u);
  assert.match(change, /if \(!workspace \|\| workspace === this\.options\.workspace\)/u);
  assert.match(change, /this\.workspaceObservationCount < 2/u);
});

test('Git history, document history, and localisation audit share the compact wrapped diff view', () => {
  const history = source('apps/review/src/git-history-panel.ts');
  const historyDiffViews = source('apps/review/src/git-history-diff-views.ts');
  const documentHistory = source('apps/review/src/history-panel.ts');
  const audit = source('apps/review/src/localisation-audit-panel.ts');
  const standard = source('apps/review/src/standard-diff-view.ts');
  const style = source('apps/review/src/style.css');
  assert.match(history, /createGitHistoryDiffViews/u);
  for (const consumer of [historyDiffViews, documentHistory, audit]) {
    assert.match(consumer, /createStandardDiffView/u);
  }
  assert.match(standard, /wordWrapOverride1: 'on'/u);
  assert.match(standard, /wordWrapOverride2: 'on'/u);
  assert.match(standard, /hideUnchangedRegions: \{ enabled: false \}/u);
  assert.match(standard, /diff\.onDidUpdateDiff\(showChangedRegionsOnly\)/u);
  assert.match(standard, /setHiddenAreas\(diff\.getOriginalEditor\(\), hiddenRanges/u);
  assert.match(standard, /layoutFrame = window\.requestAnimationFrame\([\s\S]*diff\.layout\(\);[\s\S]*showChangedRegionsOnly\(\)/u);
  assert.match(standard, /automaticLayout: !preserveOnDeactivate/u);
  assert.match(standard, /if \(preserveOnDeactivate\) diff\.getOriginalEditor\(\)\.layout\(\)/u);
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
