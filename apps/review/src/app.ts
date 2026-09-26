import * as monaco from 'monaco-editor'; import './style.css';
import { createAvatarProfile } from './avatar-profile.ts'; import { createCollaborationPanel } from './collaboration-panel.ts';
import { createDecorationRenderer } from './editor-decorations.ts'; import { applyDocumentStatus } from './document-status.ts';
import { createEditingModeController } from './editing-mode.ts'; import { createEditorCoordinates } from './editor-coordinates.ts';
import { createEnglishOriginal } from './english-original.ts'; import { createGitHistoryPanel, createHistoryPanel } from './history-panel.ts';
import { createKeyReplacementPanel } from './key-replacement-panel.ts';
import { createPresenceController } from './presence-controller.ts'; import { createReviewCards } from './review-cards.ts';
import { createReviewNavigation } from './review-navigation.ts'; import { createCollaborationRefresh, createReviewRefresh } from './review-refresh.ts';
import { createRecoveryBanner } from './recovery-banner.ts';
import { createTicketPanel } from './ticket-panel.ts'; import { createDeletedBranchesPanel } from './deleted-branches-panel.ts';
import { createScrollSync } from './scroll-sync.ts'; import { createSyntaxDiagnostics } from './syntax-diagnostics.ts';
import { configureReadOnlyReview } from './read-only-review.ts';
import { createAgentConnection } from './agent-connection.ts';
import { createGitConflictDiff } from './git-conflict-diff.ts'; import { resetExternalConflicts, storeExternalConflict } from './git-conflict-state.ts';
import { createDocumentVariants } from './document-variants.ts';
import { createRemoteDocument } from './remote-document.ts';
import { createLocalisationAuditPanel } from './localisation-audit-panel.ts'; import { createHelpPanel } from './help-panel.ts';
import { createNotificationCenter } from './notification-center.ts';
import { requiredButton, requiredElement } from './dom-elements.ts';
import { createAppState } from './app-state.ts';
import { parseAgentMessage } from './agent-message.ts';
import type { BootstrapPayload } from './app-state.ts';
import { createAppbarLayout } from './appbar-layout.ts'; import { createEditorSettings } from './editor-settings.ts'; import { createSpellcheck } from './spellcheck.ts'; import { createWorkspaceTabs } from './workspace-tabs.ts';
import {
  createDialogController, decodeBase64, encodeBase64, utf16ToByte,
} from './review-utilities.ts';
(self as typeof self & { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new Worker('/editor.worker.js', { type: 'module' }) };
const hash = new URLSearchParams(location.hash.slice(1)), token = hash.get('token') ?? '';
const requestedPath = hash.get('path') ?? '', requestedTicket = hash.get('ticket') ?? '', readOnlyMode = hash.get('readOnly') ?? '', requestedPair = hash.get('pair') ?? '', requestedCommit = hash.get('commit') ?? '', requestedLine = Number(hash.get('line') ?? 0);
const state = createAppState(), statusElement = requiredElement('#status'), toastElement = requiredElement('#toast');
const appbarLayout = createAppbarLayout(requiredElement('.appbar'));
const askText = createDialogController(); let toastTimer: ReturnType<typeof setTimeout> | undefined;
function setStatus(text: string, error = false): void { statusElement.textContent = text; statusElement.classList.toggle('error', error); }
function showToast(text: string, error = false): void { clearTimeout(toastTimer); toastElement.textContent = text;
  toastElement.classList.toggle('error', error); toastElement.classList.add('visible');
  toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 4200);
}
const workspaceTabs = createWorkspaceTabs({ token, requestedPath, requestedTicket, readOnlyMode, showToast });
monaco.languages.register({ id: 'eaw-yaml' });
monaco.languages.setMonarchTokensProvider('eaw-yaml', { tokenizer: { root: [
  [/^\s*l_[a-z_]+:/, 'keyword'], [/^\s*[^#\s][^:]*?(?=:(?:\d+)?\s)/, 'type.identifier'],
  [/:\d+/, 'number'], [/"(?:[^"\\]|\\.)*"/, 'string'], [/#.*$/, 'comment'],
] } });
const editor = monaco.editor.create(requiredElement('#editor'), {
  value: '', language: 'eaw-yaml', theme: 'vs-dark', automaticLayout: true, readOnly: true,
  fontFamily: 'Consolas, monospace', fontSize: 15, lineHeight: 23, minimap: { enabled: false },
  wordWrap: 'on', glyphMargin: true, padding: { top: 12, bottom: 40 }, scrollBeyondLastLine: false,
  renderWhitespace: 'selection', roundedSelection: false, unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
}); let agentConnection: ReturnType<typeof createAgentConnection> | undefined;
createEditorSettings({ monaco, editor, showToast });
const spellcheck = createSpellcheck({ monaco, editor, token, showToast }); const syntaxDiagnostics = createSyntaxDiagnostics({ monaco, editor, token, showToast, getFilePath: () => state.relativePath });
function send(message: { type: string; [field: string]: unknown }): void {
  agentConnection?.send(state.reviewDocument?.anchor(message) ?? message);
}
const { rangeFromBytes, selectionBytes, jumpToBytes } = createEditorCoordinates({ monaco, state, editor });
let editingMode!: ReturnType<typeof createEditingModeController>;
const reviewCards = createReviewCards({
  state, editor, rangeFromBytes, send, askText,
  onEditSuggestion: (item) => editingMode?.editSuggestion(item),
  onAcceptSuggestion: (item) => editingMode?.acceptSuggestion(item),
  onRevertSuggestion: (item) => editingMode?.revertSuggestion(item),
});
const gitConflictDiff = createGitConflictDiff({ monaco, state, send });
const collaborationPanel = createCollaborationPanel({
  state, editor, send, selectionBytes, jumpToBytes, showToast,
  openConflictDiff: gitConflictDiff.open,
});
const refreshDecorations = createDecorationRenderer({
  monaco, state, editor, rangeFromBytes, onLayout: reviewCards.layout,
});
const reviewRefresh = createReviewRefresh(() => {
  refreshDecorations();
  reviewCards.render();
});
const presenceController = createPresenceController({ state, editor, send });
editingMode = createEditingModeController({
  state, editor, send, showToast,
  onDraftStateChange: reviewRefresh.schedule,
});
const avatarProfile = createAvatarProfile({ state, send, showToast });
const recoveryBanner = createRecoveryBanner({ state, send, showToast });
let documentClosing = false;
async function closeActiveDocument({ flush = true } = {}) {
  if (documentClosing || !state.path) return;
  documentClosing = true;
  editingMode?.flushSuggestion();
  state.ready = false;
  state.presences.clear();
  collaborationRefresh.refreshAll();
  agentConnection?.send({ type: 'deactivate', path: state.path });
  agentConnection?.send({ type: 'close', path: state.path });
  if (flush) await agentConnection?.flush();
}
const ticketPanel = createTicketPanel({
  monaco, state, editor, token, requestedPath, showToast, beforeNavigate: closeActiveDocument,
});
const deletedBranchesPanel = createDeletedBranchesPanel({ monaco, token, showToast });
const keyReplacementPanel = createKeyReplacementPanel({ state, token, showToast }); const localisationAuditPanel = createLocalisationAuditPanel({ monaco, state, token, showToast });
const helpPanel = createHelpPanel({ state, token, showToast }); const notificationCenter = createNotificationCenter({ token, showToast });
const scrollSync = createScrollSync({ editor, initialPair: requestedPair });
createEnglishOriginal({ state, editor, token, showToast, onOpened: (pair) => scrollSync.setPair(pair) });
const historyPanel = createHistoryPanel({ monaco, state, editor, send, showToast }); const gitHistoryPanel = createGitHistoryPanel({ monaco, state, token, showToast });
const documentVariants = createDocumentVariants({
  monaco, state, editor, send, showToast,
  beforeChange: () => editingMode.beforeRemoteChange(),
  afterChange: () => editingMode.afterRemoteChange(),
  onChanged: () => { reviewRefresh.schedule(); collaborationPanel.refresh(); },
});
const collaborationRefresh = createCollaborationRefresh(refreshDecorations, collaborationPanel);
const applyRemoteReplace = createRemoteDocument({
  state, editor, editingMode, send,
  onChanged: () => { reviewRefresh.schedule(); collaborationPanel.refresh(); },
});
function handleMessage(raw: unknown): void {
  const message = parseAgentMessage(raw);
  if (!message) return;
  if (message.type === 'ticketCatalogChanged') { ticketPanel.refresh(message.revision); return; }
  if (message.type === 'ticketUnavailable' && message.ticketId === state.ticket?.id) {
    ticketPanel.leaveUnavailable(message.reason); return;
  }
  if (message.path && message.path.toLowerCase() !== state.path.toLowerCase()) return;
  if (reviewRefresh.handleBatch(message.type)) return;
  if (message.type === 'agentHello') {
    Object.assign(state, {
      user: message.user, userId: message.userId, color: message.color,
      avatarBase64: message.avatarBase64 ?? '',
      // Keep the banner hidden until Agent relays an explicit status received from the server.
      recoveryStatus: message.recoveryStatus ?? '',
      temporaryPassword: message.temporaryPassword === true,
      workspace: message.workspace || state.workspace,
      version: message.version || state.version, serverVersion: message.serverVersion || state.serverVersion,
      trainingProgress: message.trainingProgress ?? state.trainingProgress,
      trainingProgressConfirmed: message.trainingProgressConfirmed === true,
    });
    setStatus(`${message.user} · ${message.workspace}`);
    collaborationPanel.refresh();
    avatarProfile.refresh();
    recoveryBanner.refresh();
    helpPanel.refresh();
  } else if (message.type === 'documentStatus') {
    applyDocumentStatus(message, state, editor, setStatus);
  } else if (message.type === 'documentReady') {
    state.ready = true; spellcheck.start();
    state.reviewDocument?.replay();
    send({ type: 'activate', path: state.path, positionByte: 0, anchorByte: 0 });
    ticketPanel.refresh();
    editor.updateOptions({ readOnly: state.documentView !== 'shared'
      || ['applied', 'closed'].includes(state.ticket?.status ?? '') });
    setStatus('Совместный документ подключён');
    presenceController.publish();
  } else if (message.type === 'documentSync') state.reviewDocument?.receive(message);
  else if (message.type === 'replace') applyRemoteReplace(message);
  else if (message.type === 'documentVariants') documentVariants.update(message);
  else if (message.type === 'documentVariant') documentVariants.updateAuthor(message);
  else if (message.type === 'personalFileStatus') documentVariants.status(message);
  else if (message.type === 'presenceReset') state.presences.clear();
  else if (message.type === 'presence') state.presences.set(message.clientId, message);
  else if (message.type === 'presenceSnapshot') state.presences = new Map(
    (message.presences ?? []).map((item) => [item.clientId, item]),
  );
  else if (message.type === 'reservationReset') state.reservations.clear();
  else if (message.type === 'reservation') state.reservations.set(message.id, message);
  else if (message.type === 'reservationSnapshot') {
    state.reservations = new Map(
      (message.reservations ?? []).map((item) => [item.id, item]),
    );
  }
  else if (message.type === 'reservationTargetReset') state.reservationTargets = [];
  else if (message.type === 'reservationTarget') state.reservationTargets.push(message);
  else if (message.type === 'reservationTargetSnapshot') state.reservationTargets = message.targets ?? [];
  else if (message.type === 'externalConflictReset') resetExternalConflicts(state, message.source);
  else if (message.type === 'externalConflict') storeExternalConflict(state, message);
  else if (message.type === 'commentReset') { state.comments.clear(); state.commentMessages.clear(); }
  else if (message.type === 'commentThread') state.comments.set(message.id, message);
  else if (message.type === 'commentMessage') {
    const messages = state.commentMessages.get(message.id) ?? [];
    messages.push(message); state.commentMessages.set(message.id, messages);
  } else if (message.type === 'suggestionReset') { state.suggestions.clear(); state.suggestionMessages.clear(); }
  else if (message.type === 'suggestion') state.suggestions.set(message.id, message);
  else if (message.type === 'suggestionMessage') {
    const messages = state.suggestionMessages.get(message.id) ?? [];
    messages.push(message); state.suggestionMessages.set(message.id, messages);
  } else if (message.type === 'notice') showToast(message.message);
  else if (message.type === 'history') historyPanel.update(message.entries ?? [], message.headId ?? '');
  else if (message.type === 'historyVersion') historyPanel.receiveVersion(message);
  else if (message.type === 'recoveryCode') recoveryBanner.save(message.recoveryCode);
  else if (message.type === 'workspaceChanged') {
    state.workspace = message.workspace || state.workspace;
    const ready = message.phase === 'ready';
    if (!state.ticket) requiredElement('#document-name').textContent = `${state.relativePath} · ${state.workspace}`;
    if (!ready) {
      state.ready = false;
      resetExternalConflicts(state);
      editor.updateOptions({ readOnly: true });
      collaborationPanel.refresh();
    }
    setStatus(message.message, !ready);
    showToast(message.message, !ready);
  } else if (message.type === 'error') {
    setStatus(message.message, true);
    showToast(message.message, true);
  }
  if (/^(presence|reservation|externalConflict)/.test(message.type)) collaborationRefresh.schedule(message.type);
  if (/^(comment|suggestion)/.test(message.type)) reviewRefresh.schedule();
}
function collaborativeUndo() { if (state.ready) editingMode.undo(); }
function collaborativeRedo() { if (state.ready) editingMode.redo(); }
requiredButton('#undo').addEventListener('click', collaborativeUndo);
requiredButton('#redo').addEventListener('click', collaborativeRedo);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, collaborativeUndo);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, collaborativeRedo);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, collaborativeRedo);
editor.addCommand(monaco.KeyCode.Enter, () => state.ready && editingMode.insertLineBreak());
const reviewNavigation = createReviewNavigation({
  state, editor,
  positionByteAt: (position) => {
    const model = editor.getModel();
    if (!model) throw new Error('Редактор не содержит документа.');
    return utf16ToByte(model.getValue(), model.getOffsetAt(position));
  },
  focusCard: reviewCards.focusCard,
  onSuggestion: (suggestion) => {
    const own = suggestion.authorId ? suggestion.authorId === state.userId : suggestion.author === state.user;
    if (state.editingSuggestionId || !editingMode.isSuggesting() || !own) return;
    const item = state.suggestions.get(suggestion.id);
    if (item) editingMode.editSuggestion(item);
  },
});
editor.onDidScrollChange(reviewCards.syncScroll);
requiredElement('#review-lane').addEventListener('scroll', reviewCards.layout);
window.addEventListener('resize', reviewCards.layout);
requiredButton('#comment-create').addEventListener('click', async () => {
  const body = await askText('Новый комментарий', 'Комментарий к выделению или позиции курсора');
  if (body?.trim()) {
    const range = selectionBytes();
    send({ type: 'commentCreate', path: state.path, startByte: range.start, endByte: range.end,
      bodyBase64: encodeBase64(body.trim()) });
  }
});
async function start() {
  if (!token || !requestedPath) throw new Error('Review-приложение запущено без локальной сессии или файла.');
  const bootstrapQuery = new URLSearchParams({ path: requestedPath });
  if (requestedTicket) bootstrapQuery.set('ticket', requestedTicket);
  if (readOnlyMode) bootstrapQuery.set('readonly', readOnlyMode);
  if (requestedCommit) bootstrapQuery.set('commit', requestedCommit);
  const bootstrap = await fetch(`/api/bootstrap?${bootstrapQuery}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  const data = await bootstrap.json() as BootstrapPayload;
  if (!bootstrap.ok) throw new Error(data.error || 'Не удалось открыть файл.');
  Object.assign(state, {
    path: data.path, relativePath: data.relativePath, workspace: data.workspace,
    ticket: data.ticket, user: data.user, color: data.color,
  }); gitHistoryPanel.setAvailable(true);
  workspaceTabs.confirmPath(data.path, data.relativePath, data.ticket);
  const ticketReadOnly = ['applied', 'closed'].includes(state.ticket?.status ?? '');
  for (const id of [
    'mode-edit', 'mode-suggest', 'undo', 'redo', 'comment-create',
    'reservation-create', 'reservation-delete-at', 'reservation-delete',
  ]) {
    requiredButton(`#${id}`).disabled = ticketReadOnly;
  }
  const contextName = data.ticket ? `тикет «${data.ticket.title}»` : data.workspace;
  requiredElement('#document-name').textContent = `${data.relativePath} · ${contextName}`;
  editor.setValue(decodeBase64(data.textBase64)); syntaxDiagnostics.refresh();
  if (!requestedLine) workspaceTabs.restore(editor, data.path);
  if (data.readOnly) {
    configureReadOnlyReview({ data, editor, requestedLine, setStatus });
    return;
  }
  collaborationPanel.refresh();
  await ticketPanel.initialise();
  agentConnection = createAgentConnection({
    token,
    onMessage: handleMessage,
    onOpen: () => {
      send({
        type: 'open', path: state.path, textBase64: encodeBase64(editor.getValue()), crdt: 'yjs-v1',
        ...(state.ticket ? { ticketId: state.ticket.id } : {}),
      });
    },
    onWaiting: (_delay, error = '') => {
      state.ready = false;
      editor.updateOptions({ readOnly: true });
      setStatus(error || 'Desktop Agent отключён – ожидается автоматическое переподключение…', true);
    },
  });
}
start().catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
window.addEventListener('beforeunload', () => {
  workspaceTabs.remember(editor);
  void closeActiveDocument({ flush: false });
  ticketPanel.dispose(); deletedBranchesPanel.dispose(); keyReplacementPanel.dispose(); localisationAuditPanel.dispose(); helpPanel.dispose();
  notificationCenter.dispose(); editingMode.flushSuggestion(); editingMode.dispose();
  state.reviewDocument?.dispose(); presenceController.dispose();
  historyPanel.dispose(); gitHistoryPanel.dispose(); documentVariants.dispose();
  scrollSync.dispose(); reviewRefresh.dispose(); collaborationRefresh.dispose(); spellcheck.dispose(); syntaxDiagnostics.dispose();
  reviewNavigation.dispose(); appbarLayout.dispose(); agentConnection?.dispose(); gitConflictDiff.dispose();
});
