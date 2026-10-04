import type * as Monaco from 'monaco-editor';
import { embeddedSessionId, postWorkspace, WORKSPACE_BRIDGE } from './workspace-bridge.ts';
import { WORKSPACE_SLEEP_KEY, workspaceSleepSettings } from './workspace-sleep.ts';

let visible = !embeddedSessionId() || new URLSearchParams(location.hash.slice(1)).get('foreground') === '1';
export function isWorkspaceVisible() { return visible; }
interface RuntimeOptions {
  state: { path:string; ready:boolean; applyingRemote:boolean; editingSuggestionId:string };
  editor: Monaco.editor.IStandaloneCodeEditor;
  hasDraft: () => boolean;
  send: (message: {type:string; path:string; [key:string]:unknown}) => void;
  onVisible: () => void;
  close: () => Promise<void>;
}
export function createWorkspaceRuntime({ state, editor, hasDraft, send, onVisible, close }: RuntimeOptions) {
  if (!embeddedSessionId()) return { ready() {}, dispose() {} };
  let hasUndo = false, restored = false, receivedRestore = false, viewState: Monaco.editor.ICodeEditorViewState | null = null;
  let position:Monaco.IPosition|null = null, scrollTop:number|undefined;
  function restore() {
    if (restored || !receivedRestore || !state.ready) return;
    restored = true;
    if (viewState) editor.restoreViewState(viewState);
    else { if (position) editor.setPosition(position); if (typeof scrollTop === 'number') editor.setScrollTop(scrollTop); }
  }
  const changed = editor.onDidChangeModelContent(() => { if (state.ready && !state.applyingRemote) hasUndo = true; });
  const protectedState = () => !state.ready || hasUndo || hasDraft() || Boolean(state.editingSuggestionId)
    || Boolean(document.querySelector('dialog[open]'));
  const report = () => postWorkspace('state', { protected:protectedState(),
    viewState:editor.saveViewState(), position:editor.getPosition(), scrollTop:editor.getScrollTop() });
  const receive = async (event:MessageEvent) => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.bridge !== WORKSPACE_BRIDGE
      || event.data.sessionId !== embeddedSessionId()) return;
    const message = event.data;
    if (message.operation === 'visibility') {
      if (visible === Boolean(message.visible)) return;
      visible = Boolean(message.visible);
      window.dispatchEvent(new Event('workspacevisibilitychange'));
      if (visible) { editor.layout(); if (state.ready) { send({type:'activate',path:state.path,positionByte:0,anchorByte:0}); onVisible(); } }
      else send({type:'deactivate',path:state.path});
      report();
    } else if (message.operation === 'restore') { receivedRestore = true; viewState = message.viewState; position = message.position; scrollTop = message.scrollTop; restore(); }
    else if (message.operation === 'prepareSleep') {
      report(); postWorkspace('sleepPrepared', { safe:!visible && !protectedState() });
    } else if (message.operation === 'prepareClose') {
      await close(); postWorkspace('closed');
    } else if (message.operation === 'freeze') state.ready = false;
  };
  window.addEventListener('message', receive);
  const timer = setInterval(report, 5000);
  const enabled = document.querySelector<HTMLInputElement>('#workspace-sleep-enabled');
  const idle = document.querySelector<HTMLSelectElement>('#workspace-sleep-minutes');
  const limit = document.querySelector<HTMLSelectElement>('#workspace-warm-limit');
  function settings() {
    let value = {}; try { value = JSON.parse(localStorage.getItem(WORKSPACE_SLEEP_KEY) || '{}'); } catch {}
    const s = workspaceSleepSettings(value);
    if (enabled) enabled.checked = s.enabled; if (idle) idle.value = String(s.idleMinutes); if (limit) limit.value = String(s.warmLimit);
  }
  settings();
  window.addEventListener('storage', settings);
  for (const input of [enabled,idle,limit]) input?.addEventListener('change', () => {
    localStorage.setItem(WORKSPACE_SLEEP_KEY, JSON.stringify(workspaceSleepSettings({ enabled:enabled?.checked,
      idleMinutes:Number(idle?.value), warmLimit:Number(limit?.value) })));
  });
  postWorkspace('mounted');
  return { ready() {
    restore();
    report();
  }, dispose() { clearInterval(timer); changed.dispose(); window.removeEventListener('message', receive); window.removeEventListener('storage',settings); } };
}
