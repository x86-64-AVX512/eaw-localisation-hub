import * as monaco from 'monaco-editor'; import './style.css';
import { createAvatarProfile } from './avatar-profile.js'; import { createCollaborationPanel } from './collaboration-panel.js';
import { createDecorationRenderer } from './editor-decorations.js'; import { applyDocumentStatus } from './document-status.js';
import { baseToProjectedOffset, createEditingModeController, projectedToBaseOffset } from './editing-mode.js';
import { createEnglishOriginal } from './english-original.js';
import { createGitHistoryPanel, createHistoryPanel } from './history-panel.js';
import { createKeyReplacementPanel } from './key-replacement-panel.js';
import { createPresenceController } from './presence-controller.js'; import { createReviewCards } from './review-cards.js';
import { createReviewNavigation } from './review-navigation.js';
import { createReviewRefresh } from './review-refresh.js';
import { createRecoveryBanner } from './recovery-banner.js';
import { createTicketPanel } from './ticket-panel.js';
import { createScrollSync } from './scroll-sync.js';
import { configureReadOnlyReview } from './read-only-review.js';
import { createAgentConnection } from './agent-connection.js';
import { createGitConflictDiff } from './git-conflict-diff.js'; import { resetExternalConflicts, storeExternalConflict } from './git-conflict-state.js';
import { createDocumentVariants } from './document-variants.js';
import { createRemoteDocument } from './remote-document.js';
import {
  byteToUtf16, createDialogController, decodeBase64, encodeBase64, utf16ToByte,
} from './review-utilities.js';
self.MonacoEnvironment = { getWorker: () => new Worker('/editor.worker.js', { type: 'module' }) };
const hash = new URLSearchParams(location.hash.slice(1)), token = hash.get('token') ?? '';
const requestedPath = hash.get('path') ?? '', requestedTicket = hash.get('ticket') ?? '', readOnlyMode = hash.get('readOnly') ?? '', requestedPair = hash.get('pair') ?? '', requestedCommit = hash.get('commit') ?? '', requestedLine = Number(hash.get('line') ?? 0);
const state = {
  path: '', relativePath: '', workspace: '', ticket: null,
  user: '', userId: '', color: '#6aa9ff', avatarBase64: '', ready: false, applyingRemote: false,
  suggestions: new Map(), comments: new Map(), presences: new Map(), reservations: new Map(),
  reservationTargets: [], externalConflicts: new Map(), selectedReservation: '', selectedConflict: '',
  suggestionMessages: new Map(), commentMessages: new Map(),
  recoveryStatus: '', temporaryPassword: false,
  history: [], historyHeadId: '', editingSuggestionId: '', suggestionProjection: null,
  documentView: 'shared', documentVariants: null,
};
const statusElement = document.querySelector('#status'), toastElement = document.querySelector('#toast');
const askText = createDialogController(); let toastTimer;
function setStatus(text, error = false) {
  statusElement.textContent = text;
  statusElement.classList.toggle('error', error);
}
function showToast(text, error = false) {
  clearTimeout(toastTimer);
  toastElement.textContent = text;
  toastElement.classList.toggle('error', error);
  toastElement.classList.add('visible');
  toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 4200);
}
monaco.languages.register({ id: 'eaw-yaml' });
monaco.languages.setMonarchTokensProvider('eaw-yaml', { tokenizer: { root: [
  [/^\s*l_[a-z_]+:/, 'keyword'], [/^\s*[^#\s][^:]*?(?=:\d+\s)/, 'type.identifier'],
  [/:\d+/, 'number'], [/"(?:[^"\\]|\\.)*"/, 'string'], [/#.*$/, 'comment'],
] } });
const editor = monaco.editor.create(document.querySelector('#editor'), {
  value: '', language: 'eaw-yaml', theme: 'vs-dark', automaticLayout: true, readOnly: true,
  fontFamily: 'Consolas, monospace', fontSize: 15, lineHeight: 23, minimap: { enabled: false },
  wordWrap: 'on', glyphMargin: true, padding: { top: 12, bottom: 40 }, scrollBeyondLastLine: false,
  renderWhitespace: 'selection', roundedSelection: false,
}); let agentConnection;
function send(message) { agentConnection?.send(message); }
function rangeFromBytes(startByte, endByte) {
  const model = editor.getModel();
  const projection = state.suggestionProjection;
  const text = projection?.baseText ?? model.getValue();
  const baseStart = byteToUtf16(text, Number(startByte));
  const baseEnd = byteToUtf16(text, Number(endByte));
  const startOffset = baseToProjectedOffset(projection, baseStart, 'before');
  const endOffset = baseToProjectedOffset(
    projection, baseEnd, startByte === endByte ? 'before' : 'after',
  );
  const start = model.getPositionAt(startOffset);
  const end = model.getPositionAt(endOffset);
  return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
}
function selectionBytes() {
  const model = editor.getModel();
  const selection = editor.getSelection();
  const projection = state.suggestionProjection;
  const source = projection?.baseText ?? model.getValue();
  const start = projectedToBaseOffset(projection, model.getOffsetAt(selection.getStartPosition()));
  const end = projectedToBaseOffset(projection, model.getOffsetAt(selection.getEndPosition()));
  return { start: utf16ToByte(source, start), end: utf16ToByte(source, end) };
}
function jumpToBytes(startByte, endByte = startByte) {
  const range = rangeFromBytes(startByte, endByte);
  editor.revealRangeInCenter(range);
  editor.setSelection(range);
  editor.focus();
}
let editingMode;
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
const ticketPanel = createTicketPanel({ monaco, state, token, requestedPath, showToast });
const keyReplacementPanel = createKeyReplacementPanel({ state, token, showToast });
const scrollSync = createScrollSync({ editor, initialPair: requestedPair });
createEnglishOriginal({ state, editor, token, showToast, onOpened: (pair) => scrollSync.setPair(pair) });
const historyPanel = createHistoryPanel({ monaco, state, editor, send, showToast }); const gitHistoryPanel = createGitHistoryPanel({ monaco, state, token, showToast });
const documentVariants = createDocumentVariants({
  state, editor, send, showToast,
  beforeChange: () => editingMode.beforeRemoteChange(),
  afterChange: () => editingMode.afterRemoteChange(),
  onChanged: () => { reviewRefresh.schedule(); collaborationPanel.refresh(); },
});
function refreshCollaboration() {
  refreshDecorations();
  collaborationPanel.refresh();
}
const applyRemoteReplace = createRemoteDocument({
  state, editor, editingMode,
  onChanged: () => { reviewRefresh.schedule(); collaborationPanel.refresh(); },
});
function handleMessage(message) {
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
    });
    setStatus(`${message.user} · ${message.workspace}`);
    collaborationPanel.refresh();
    avatarProfile.refresh();
    recoveryBanner.refresh();
  } else if (message.type === 'documentStatus') {
    applyDocumentStatus(message, state, editor, setStatus);
  } else if (message.type === 'documentReady') {
    state.ready = true;
    editor.updateOptions({ readOnly: state.documentView !== 'shared'
      || ['applied', 'closed'].includes(state.ticket?.status) });
    setStatus('Совместный документ подключён');
    presenceController.publish();
  } else if (message.type === 'replace') applyRemoteReplace(message);
  else if (message.type === 'documentVariants') documentVariants.update(message);
  else if (message.type === 'documentVariant') documentVariants.updateAuthor(message);
  else if (message.type === 'personalFileStatus') documentVariants.status(message);
  else if (message.type === 'presenceReset') state.presences.clear();
  else if (message.type === 'presence') state.presences.set(message.clientId, message);
  else if (message.type === 'reservationReset') state.reservations.clear();
  else if (message.type === 'reservation') state.reservations.set(message.id, message);
  else if (message.type === 'reservationTargetReset') state.reservationTargets = [];
  else if (message.type === 'reservationTarget') state.reservationTargets.push(message);
  else if (message.type === 'externalConflictReset') resetExternalConflicts(state, message.source);
  else if (message.type === 'externalConflict') storeExternalConflict(state, message);
  else if (message.type === 'commentReset') { state.comments.clear(); state.commentMessages.clear(); }
  else if (message.type === 'commentThread') state.comments.set(message.id, message);
  else if (message.type === 'commentMessage') {
    if (!state.commentMessages.has(message.id)) state.commentMessages.set(message.id, []);
    state.commentMessages.get(message.id).push(message);
  } else if (message.type === 'suggestionReset') { state.suggestions.clear(); state.suggestionMessages.clear(); }
  else if (message.type === 'suggestion') state.suggestions.set(message.id, message);
  else if (message.type === 'suggestionMessage') {
    if (!state.suggestionMessages.has(message.id)) state.suggestionMessages.set(message.id, []);
    state.suggestionMessages.get(message.id).push(message);
  } else if (message.type === 'notice') showToast(message.message);
  else if (message.type === 'history') historyPanel.update(message.entries ?? [], message.headId ?? '');
  else if (message.type === 'historyVersion') historyPanel.receiveVersion(message);
  else if (message.type === 'recoveryCode') recoveryBanner.save(message.recoveryCode);
  else if (message.type === 'workspaceChanged') {
    state.workspace = message.workspace || state.workspace;
    const ready = message.phase === 'ready';
    if (!state.ticket) document.querySelector('#document-name').textContent = `${state.relativePath} · ${state.workspace}`;
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
  if (/^(presence|reservation|externalConflict)/.test(message.type)) refreshCollaboration();
  if (/^(comment|suggestion)/.test(message.type)) reviewRefresh.schedule();
}
function collaborativeUndo() { if (state.ready) editingMode.undo(); }
function collaborativeRedo() { if (state.ready) editingMode.redo(); }
document.querySelector('#undo').addEventListener('click', collaborativeUndo);
document.querySelector('#redo').addEventListener('click', collaborativeRedo);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, collaborativeUndo);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, collaborativeRedo);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, collaborativeRedo);
editor.addCommand(monaco.KeyCode.Enter, () => state.ready && editingMode.insertLineBreak());
const reviewNavigation = createReviewNavigation({
  state, editor,
  positionByteAt: (position) => {
    const model = editor.getModel();
    return utf16ToByte(model.getValue(), model.getOffsetAt(position));
  },
  focusCard: reviewCards.focusCard,
  onSuggestion: (suggestion) => {
    const own = suggestion.authorId ? suggestion.authorId === state.userId : suggestion.author === state.user;
    if (state.editingSuggestionId || !editingMode.isSuggesting() || !own) return;
    editingMode.editSuggestion(suggestion);
  },
});
editor.onDidScrollChange(reviewCards.layout);
document.querySelector('#review-lane').addEventListener('scroll', reviewCards.layout);
window.addEventListener('resize', reviewCards.layout);
document.querySelector('#comment-create').addEventListener('click', async () => {
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
  const data = await bootstrap.json();
  if (!bootstrap.ok) throw new Error(data.error || 'Не удалось открыть файл.');
  Object.assign(state, {
    path: data.path, relativePath: data.relativePath, workspace: data.workspace,
    ticket: data.ticket, user: data.user, color: data.color,
  }); gitHistoryPanel.setAvailable(true);
  const ticketReadOnly = ['applied', 'closed'].includes(state.ticket?.status);
  for (const id of [
    'mode-edit', 'mode-suggest', 'undo', 'redo', 'comment-create',
    'reservation-create', 'reservation-delete-at', 'reservation-delete',
  ]) {
    const control = document.querySelector(`#${id}`);
    if (control) control.disabled = ticketReadOnly;
  }
  const contextName = data.ticket ? `тикет «${data.ticket.title}»` : data.workspace;
  document.querySelector('#document-name').textContent = `${data.relativePath} · ${contextName}`;
  editor.setValue(decodeBase64(data.textBase64));
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
        type: 'open', path: state.path, textBase64: encodeBase64(editor.getValue()),
        ...(state.ticket ? { ticketId: state.ticket.id } : {}),
      });
      send({ type: 'activate', path: state.path, positionByte: 0, anchorByte: 0 });
    },
    onWaiting: (_delay, error = '') => {
      state.ready = false;
      editor.updateOptions({ readOnly: true });
      setStatus(error || 'Desktop Agent отключён — ожидается автоматическое переподключение…', true);
    },
  });
}
start().catch((error) => setStatus(error.message, true));
window.addEventListener('beforeunload', () => {
  ticketPanel.dispose();
  keyReplacementPanel.dispose();
  editingMode.flushSuggestion();
  editingMode.dispose();
  presenceController.dispose();
  historyPanel.dispose(); gitHistoryPanel.dispose();
  scrollSync.dispose();
  reviewRefresh.dispose();
  reviewNavigation.dispose();
  agentConnection?.dispose();
  gitConflictDiff.dispose();
  if (state.path) send({ type: 'deactivate', path: state.path });
});
