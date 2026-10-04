import './style.css';
import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { createAgentConnection } from './agent-connection.ts';
import { WORKSPACE_BRIDGE } from './workspace-bridge.ts';
import { createWorkspaceTabs, workspaceTabIdentity } from './workspace-tabs.ts';
import type { WorkspaceTab } from './workspace-tabs.ts';
import { WORKSPACE_SLEEP_KEY, workspaceSleepCandidates, workspaceSleepSettings } from './workspace-sleep.ts';

interface Session {
  tab:WorkspaceTab; id:string; frame:HTMLIFrameElement|null; lastUsed:number;
  protected:boolean; pending:boolean; connected:boolean; registered:boolean;
  viewState:unknown; closing:boolean;
  sleepSent?:boolean; preparationDeadline?:number;
}
export function createWorkspaceWindow() {
  const hash = new URLSearchParams(location.hash.slice(1)), token = hash.get('token') ?? '';
  const bar = document.querySelector<HTMLElement>('#document-tabs')!;
  const picker = document.querySelector<HTMLDialogElement>('#file-picker-dialog')!;
  const toast = document.querySelector<HTMLElement>('#toast')!;
  const host = document.createElement('main'); host.className = 'document-sessions';
  const empty = document.createElement('p'); empty.className = 'workspace-placeholder'; host.append(empty);
  document.body.classList.add('workspace-window');
  document.body.replaceChildren(host,bar,picker,toast);
  let active:Session|null = null, online = false, disposed = false, toastTimer = 0;
  let reloading = false;
  const reloadWaiters = new Map<Session,() => void>();
  const sessions:Session[] = [];
  const key = (tab:WorkspaceTab) => workspaceTabIdentity(tab.path,tab.ticket);
  function showToast(message:string, error = false) {
    toast.textContent = message; toast.classList.toggle('error',error); toast.classList.add('visible');
    clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove('visible'),4200);
  }
  const tabs = createWorkspaceTabs({ token,requestedPath:hash.get('path') ?? '',requestedTicket:hash.get('ticket') ?? '',
    readOnlyMode:'',showToast,onNavigate:select,onClose:tab => { requestClose(tab); return false; } });
  for (const tab of tabs.entries()) sessions.push({ tab,id:crypto.randomUUID(),frame:null,lastUsed:0,
    protected:false,pending:false,connected:false,registered:false,viewState:null,closing:false });
  function notify(session:Session, operation:string, payload:Record<string,unknown> = {}) {
    session.frame?.contentWindow?.postMessage({bridge:WORKSPACE_BRIDGE,sessionId:session.id,operation,...payload},location.origin);
  }
  function command(session:Session, operation:string, payload:Record<string,unknown> = {}) {
    return connection.send({type:'reviewSession',sessionId:session.id,operation,...payload});
  }
  function renderVisibility() {
    for (const s of sessions) if (s.frame) {
      const visible = s === active && !s.pending;
      // Keep a real viewport for Monaco's advanced wrapping. display:none
      // reduces it to zero and can invalidate its line-measurement cache.
      s.frame.inert = !visible; notify(s,'visibility',{visible});
    }
    empty.hidden = Boolean(active?.frame && !active.pending);
    if (!active?.frame || active.pending) {
      bar.style.top = '0px'; bar.style.right = '0px';
      bar.classList.remove('occluded'); bar.inert = false;
    }
    empty.textContent = active ? uiText('Пробуждение документа…') : uiText('Откройте файл кнопкой «+».');
  }
  function wake(s:Session) {
    if (s.frame) return;
    s.id = crypto.randomUUID(); s.protected = true; s.connected = false; s.registered = false; s.pending = false;
    const params = new URLSearchParams({token,path:s.tab.path,session:s.id,foreground:s === active ? '1' : '0'});
    if (s.tab.ticket) params.set('ticket',s.tab.ticket);
    const frame = document.createElement('iframe'); frame.className = 'document-session'; frame.title = s.tab.relativePath || s.tab.path;
    frame.src = `/#${params}`; s.frame = frame; host.append(frame);
    tabs.setSleeping(s.tab.path,s.tab.ticket,false); renderVisibility();
  }
  function select(tab:WorkspaceTab) {
    if (disposed) return;
    if (active) active.lastUsed = Date.now();
    let s = sessions.find(item => key(item.tab) === key(tab));
    if (!s) { s = {tab,id:crypto.randomUUID(),frame:null,lastUsed:0,protected:false,pending:false,connected:false,registered:false,viewState:null,closing:false}; sessions.push(s); }
    active = s; s.lastUsed = Date.now();
    if (s.pending && !s.sleepSent) s.pending = false;
    // Wake allocates a new logical-session ID. Select that ID, not the
    // released sleeping one, before the new editor can publish presence.
    wake(s); if (online) command(s,'select'); renderVisibility();
    const params = new URLSearchParams({token,path:s.tab.path}); if (s.tab.ticket) params.set('ticket',s.tab.ticket);
    history.replaceState(null,'',`#${params}`);
  }
  function discard(s:Session, sleep = false) {
    s.connected = false; s.registered = false; s.pending = false; s.sleepSent = false;
    notify(s,'freeze'); s.frame?.remove(); s.frame = null;
    if (sleep) { tabs.setSleeping(s.tab.path,s.tab.ticket,true); if (active === s) wake(s); }
    else {
      if (active === s) active = null;
      sessions.splice(sessions.indexOf(s),1); tabs.remove(s.tab.path,s.tab.ticket); renderVisibility();
    }
  }
  function requestClose(tab:WorkspaceTab) {
    const s = sessions.find(item => key(item.tab) === key(tab));
    if (!s) { tabs.remove(tab.path,tab.ticket); return; }
    if (!s.frame || !s.registered) { command(s,'close'); discard(s); return; }
    if (s.closing) return; s.closing = true; notify(s,'prepareClose');
  }
  async function reloadWorkspace() {
    if (reloading) return; reloading = true;
    // A language change affects the entire window. Flush every runtime's
    // suggestion draft before unloading, retaining the saved tab list.
    await Promise.all(sessions.filter(s => s.frame && s.registered).map(s => new Promise<void>(resolve => {
      reloadWaiters.set(s,resolve); notify(s,'prepareClose');
    })));
    location.reload();
  }
  const receive = (event:MessageEvent) => {
    const data = event.data;
    if (event.origin !== location.origin || data?.bridge !== WORKSPACE_BRIDGE) return;
    const s = sessions.find(item => item.id === data.sessionId && item.frame?.contentWindow === event.source);
    if (!s) return;
    if (data.operation === 'connect') { s.registered = true; if (online) command(s,'open'); }
    else if (data.operation === 'mounted') { notify(s,'restore',{viewState:s.viewState,position:s.tab.line ? {lineNumber:s.tab.line,column:s.tab.column || 1} : null,scrollTop:s.tab.scrollTop}); renderVisibility(); }
    else if (data.operation === 'layout' && s === active) {
      bar.style.top = `${Math.max(0,Number(data.top) || 0)}px`; bar.style.height = `${Math.max(34,Number(data.height) || 34)}px`;
      bar.style.right = `${Math.max(0,Number(data.toolsWidth) || 0)}px`;
      bar.classList.toggle('occluded',Boolean(data.overlay)); bar.inert = Boolean(data.overlay);
      document.documentElement.dataset.theme = typeof data.theme === 'string' ? data.theme : 'dark';
    }
    else if (data.operation === 'openPicker' && s === active) document.getElementById('document-tab-add')?.click();
    else if (data.operation === 'closeTab' && s === active) requestClose(s.tab);
    else if (data.operation === 'send') {
      if (s !== active && ['activate','cursor'].includes(data.message?.type)) return;
      command(s,'message',{message:data.message});
    } else if (data.operation === 'confirmed') {
      const old = s.tab;
      const canonical = {...s.tab,path:data.path,relativePath:data.relativePath,ticket:data.ticket,ticketTitle:data.ticketTitle};
      const duplicate = sessions.find(item => item !== s && key(item.tab) === key(canonical));
      tabs.confirmTab(canonical,old.path,old.ticket);
      if (duplicate) {
        command(s,'close'); notify(s,'freeze'); s.frame?.remove(); sessions.splice(sessions.indexOf(s),1);
        if (active === s) select(duplicate.tab); else renderVisibility();
      } else s.tab = canonical;
    } else if (data.operation === 'state' || data.operation === 'position') {
      if (data.operation === 'state') { s.protected = data.protected !== false; s.viewState = data.viewState; }
      if (data.position) Object.assign(s.tab,{line:data.position.lineNumber,column:data.position.column,scrollTop:data.scrollTop});
      tabs.rememberTab(s.tab);
    } else if (data.operation === 'sleepPrepared' && s.pending) {
      if (data.safe === true && s !== active && online) { s.sleepSent = true; command(s,'sleep'); }
      else { s.pending = false; renderVisibility(); }
    } else if (data.operation === 'closed') {
      command(s,'close'); const finish = reloadWaiters.get(s);
      if (finish) { reloadWaiters.delete(s); finish(); } else discard(s);
    }
    else if (data.operation === 'disconnect') { if (s.connected) command(s,'close'); s.connected = false; s.registered = false; }
    else if (data.operation === 'navigate') {
      const wasActive = s === active;
      if (data.replaceCurrent) requestClose(s.tab);
      if (wasActive) tabs.open({path:data.path,relativePath:'',ticket:data.ticket ?? ''});
    }
    else if (data.operation === 'reloadWorkspace') void reloadWorkspace();
    else if (data.operation === 'flush') void connection.flush(data.timeoutMilliseconds).then(() => notify(s,'flushed',{requestId:data.requestId}));
  };
  window.addEventListener('message',receive);
  const shortcuts = (event:KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !['o','w'].includes(event.key.toLowerCase())) return;
    event.preventDefault(); if (picker.open) return;
    if (event.key.toLowerCase() === 'o') document.getElementById('document-tab-add')?.click();
    else if (active) requestClose(active.tab);
  };
  document.addEventListener('keydown',shortcuts);
  const connection = createAgentConnection({token,multiplex:true,
    onOpen:() => { online = true; if (active) command(active,'select'); for (const s of sessions) if (s.registered) command(s,'open'); },
    onWaiting:(delay,error) => {
      online = false;
      for (const s of sessions) if (s.frame) { s.connected = false; s.pending = false; s.sleepSent = false; notify(s,'waiting',{delay,error}); }
      renderVisibility();
    },
    onMessage:(raw) => {
      if (!raw || typeof raw !== 'object') return;
      const message = raw as {type:string;sessionId:string;message?:unknown;reason?:string};
      const s = sessions.find(item => item.id === message.sessionId); if (!s?.frame) return;
      if (message.type === 'reviewSessionMessage') notify(s,'message',{message:message.message});
      else if (message.type === 'reviewSessionOpened') { s.connected = true; notify(s,'opened'); }
      else if (message.type === 'reviewSessionSleepDenied') { s.pending = false; renderVisibility(); }
      else if (message.type === 'reviewSessionClosed') {
        if (message.reason === 'sleep') discard(s,true);
        else if (!reloading) { s.connected = false; s.pending = false; notify(s,'waiting',{error:uiText('Подключение документа закрыто. Переоткройте вкладку.')}); showToast(uiText('Подключение документа закрыто. Переоткройте вкладку.'),true); }
      }
    },
  });
  const timer = setInterval(() => {
    if (!online || disposed) return;
    for (const s of sessions) if (s.pending && !s.sleepSent && Date.now() > (s.preparationDeadline ?? 0)) s.pending = false;
    let settings = workspaceSleepSettings(null); try { settings = workspaceSleepSettings(JSON.parse(localStorage.getItem(WORKSPACE_SLEEP_KEY) || '{}')); } catch {}
    const warm = sessions.filter(s => s.frame && s.connected && !s.closing);
    for (const s of workspaceSleepCandidates(warm,active?.id ?? '',settings,Date.now())) {
      s.pending = true; s.sleepSent = false; s.preparationDeadline = Date.now() + 20_000; notify(s,'prepareSleep');
    }
  },15_000);
  for (const s of sessions) tabs.setSleeping(s.tab.path,s.tab.ticket,true);
  const requested = sessions.find(s => key(s.tab) === workspaceTabIdentity(hash.get('path') ?? '',hash.get('ticket') ?? ''));
  if (requested) select(requested.tab); else renderVisibility();
  window.addEventListener('beforeunload',() => {
    disposed = true; clearInterval(timer); window.removeEventListener('message',receive); document.removeEventListener('keydown',shortcuts);
    for (const s of sessions) if (s.frame) command(s,'close'); connection.dispose();
  });
}
