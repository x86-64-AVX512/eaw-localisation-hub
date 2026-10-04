import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { embeddedSessionId, postWorkspace } from './workspace-bridge.ts';
import type * as Monaco from 'monaco-editor';

const PANEL_KEY = 'eaw-hub-workbench-panels-v1';
export function workbenchPanelSettings(value:unknown):{collaboration?:boolean;discussions?:boolean} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string,unknown>;
  return { collaboration:typeof record.collaboration === 'boolean' ? record.collaboration : undefined,
    discussions:typeof record.discussions === 'boolean' ? record.discussions : undefined };
}
function loadPanels() {
  try { return workbenchPanelSettings(JSON.parse(localStorage.getItem(PANEL_KEY) || '{}')); } catch { return {}; }
}
export function createAppbarLayout(appbar: HTMLElement) {
  const tabs = document.querySelector<HTMLElement>('#document-tabs')!;
  const workspace = document.querySelector<HTMLElement>('#workspace')!;
  const menus = [...appbar.querySelectorAll<HTMLDetailsElement>('.review-menu')];
  const proxies = [...document.querySelectorAll<HTMLButtonElement>('[data-review-command]')];
  let frame = 0, lastLayout = '', positionListener:Monaco.IDisposable|undefined;
  function refresh() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const proxy of proxies) {
        const target = document.getElementById(proxy.dataset.reviewCommand!) as HTMLButtonElement|null;
        const disabled = !target || target.disabled || Boolean(target.hidden);
        if (proxy.disabled !== disabled) proxy.disabled = disabled;
        if (target?.hasAttribute('aria-pressed')) {
          const pressed = target.getAttribute('aria-pressed')!;
          if (proxy.getAttribute('aria-pressed') !== pressed) proxy.setAttribute('aria-pressed',pressed);
        }
      }
      if (!embeddedSessionId()) return;
      const rect = tabs.getBoundingClientRect(), problems = document.querySelector<HTMLElement>('#syntax-problems-open')!;
      const layout = {top:rect.top,height:rect.height,toolsWidth:problems.hidden ? 0 : problems.getBoundingClientRect().width + 8,
        overlay:Boolean(document.querySelector('dialog[open], .review-menu[open], [data-review-overlay="true"]')),theme:document.documentElement.dataset.theme ?? 'dark'};
      const signature = JSON.stringify(layout);
      if (signature !== lastLayout) { lastLayout = signature; postWorkspace('layout',layout); }
    });
  }
  const resizeObserver = new ResizeObserver(refresh);
  resizeObserver.observe(appbar); resizeObserver.observe(tabs);
  const mutationObserver = new MutationObserver(refresh);
  mutationObserver.observe(document.body,{attributes:true,attributeFilter:['hidden','disabled','open','aria-pressed','data-review-overlay'],subtree:true});
  mutationObserver.observe(document.querySelector('#syntax-problems-open')!,{childList:true,subtree:true});
  mutationObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  const closeMenus = () => { for (const menu of menus) menu.open = false; refresh(); };
  function outside(event:PointerEvent) { if (!(event.target instanceof Element) || !event.target.closest('.review-menu')) closeMenus(); }
  function keyboard(event:KeyboardEvent) {
    if (event.key === 'Escape') { const open = menus.find(menu => menu.open); closeMenus(); open?.querySelector<HTMLElement>('summary')?.focus(); return; }
    const menu = event.target instanceof Element ? event.target.closest<HTMLDetailsElement>('.review-menu') : null;
    if (!menu || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault(); menu.open = true;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled && !button.hidden);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1
      : index < 0 ? (event.key === 'ArrowUp' ? items.length-1 : 0) : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  }
  for (const menu of menus) {
    menu.addEventListener('toggle',() => { if (menu.open) for (const other of menus) if (other !== menu) other.open = false; refresh(); });
    menu.addEventListener('click',event => { if (event.target instanceof Element && event.target.closest('button')) closeMenus(); });
  }
  for (const proxy of proxies) proxy.addEventListener('click',() => {
    const target = document.getElementById(proxy.dataset.reviewCommand!) as HTMLButtonElement|null;
    if (target && !target.disabled && !target.hidden) target.click();
  });
  function panels() {
    const saved = loadPanels();
    const readonly = workspace.classList.contains('english-workspace');
    let changed = false;
    for (const [name,id] of [['collaboration','toggle-collaboration'],['discussions','toggle-discussions']] as const) {
      const expanded = !readonly && (saved[name] ?? window.innerWidth >= (name === 'collaboration' ? 960 : 680));
      if (workspace.classList.contains(`${name}-collapsed`) === expanded) changed = true;
      workspace.classList.toggle(`${name}-collapsed`,!expanded);
      const button = document.getElementById(id);
      if (button?.getAttribute('aria-pressed') !== String(expanded)) button?.setAttribute('aria-pressed',String(expanded));
    }
    if (changed) window.dispatchEvent(new Event('resize')); refresh();
  }
  for (const [name,id] of [['collaboration','toggle-collaboration'],['discussions','toggle-discussions']] as const) {
    document.getElementById(id)?.addEventListener('click',() => {
      const saved = loadPanels();
      localStorage.setItem(PANEL_KEY,JSON.stringify({...saved,[name]:workspace.classList.contains(`${name}-collapsed`)})); panels();
    });
  }
  function openFile() { closeMenus(); if (embeddedSessionId()) postWorkspace('openPicker'); else document.getElementById('document-tab-add')?.click(); }
  function closeFile() { closeMenus(); if (embeddedSessionId()) postWorkspace('closeTab'); else document.querySelector<HTMLElement>('.document-tab.active .document-tab-close')?.click(); }
  document.getElementById('file-open-menu')?.addEventListener('click',openFile);
  document.getElementById('file-close-menu')?.addEventListener('click',closeFile);
  function shortcuts(event:KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (['o','w'].includes(event.key.toLowerCase()) && document.querySelector('dialog[open]')) {
      event.preventDefault(); return;
    }
    if (event.key.toLowerCase() === 'o') { event.preventDefault(); openFile(); }
    else if (event.key.toLowerCase() === 'w' && embeddedSessionId()) { event.preventDefault(); closeFile(); }
  }
  const visible = () => { lastLayout = ''; refresh(); panels(); };
  window.addEventListener('storage',panels); window.addEventListener('resize',panels); window.addEventListener('workspacevisibilitychange',visible);
  document.addEventListener('pointerdown',outside); document.addEventListener('keydown',keyboard); document.addEventListener('keydown',shortcuts);
  panels(); document.fonts?.ready.then(refresh); refresh();
  let updatePosition = () => {};
  return { refresh, updatePosition: () => updatePosition(), connectEditor(editor:Monaco.editor.IStandaloneCodeEditor) {
    const update = () => {
      const position = editor.getPosition(); if (!position) return;
      document.getElementById('editor-position')!.textContent = uiText('Строка {0}, столбец {1}',
        position.lineNumber,position.column);
    };
    updatePosition = update;
    positionListener?.dispose(); positionListener = editor.onDidChangeCursorPosition(update); update();
  }, dispose() {
    cancelAnimationFrame(frame); resizeObserver.disconnect(); mutationObserver.disconnect(); positionListener?.dispose();
    window.removeEventListener('storage',panels); window.removeEventListener('resize',panels); window.removeEventListener('workspacevisibilitychange',visible);
    document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',keyboard); document.removeEventListener('keydown',shortcuts);
  }};
}
