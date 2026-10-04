import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmbeddedConnection, WORKSPACE_BRIDGE } from '../apps/review/src/workspace-bridge.ts';
import { createWorkspaceRuntime } from '../apps/review/src/workspace-runtime.ts';

function browser() {
  const saved = new Map(), outbound = [], window = new EventTarget();
  window.parent = { postMessage: message => outbound.push(message) };
  const values = {window,location:{origin:'http://127.0.0.1:1234',hash:'#session=a'},
    document:{querySelector:() => null},localStorage:{getItem:() => null,setItem(){}}};
  for (const [key,value] of Object.entries(values)) {
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  function receive(operation,payload = {},overrides = {}) {
    const event = Object.assign(new Event('message'),{origin:values.location.origin,source:window.parent,
      data:{bridge:WORKSPACE_BRIDGE,sessionId:'a',operation,...payload},...overrides});
    window.dispatchEvent(event);
  }
  return {window,outbound,receive,restore() {
    for (const [key,descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; }
  }};
}

test('embedded connection scopes messages by origin, parent, bridge and document session', () => {
  const b = browser(); let opened = 0, waiting = 0; const messages = [];
  const connection = createEmbeddedConnection({token:'test',onOpen:() => opened++,onWaiting:() => waiting++,onMessage:m => messages.push(m)});
  try {
    assert.equal(b.outbound.at(-1).operation,'connect');
    assert.equal(connection.send({type:'open'}),false);
    for (const overrides of [{origin:'https://other.invalid'},{source:{}},
      {data:{bridge:WORKSPACE_BRIDGE,sessionId:'b',operation:'opened'}},
      {data:{bridge:'wrong',sessionId:'a',operation:'opened'}}]) b.receive('opened',{},overrides);
    assert.equal(opened,0);
    b.receive('opened'); assert.equal(opened,1);
    assert.equal(connection.send({type:'open'}),true);
    assert.equal(b.outbound.at(-1).sessionId,'a');
    b.receive('message',{message:{type:'replace',path:'/a'}}); assert.equal(messages.length,1);
    b.receive('waiting'); assert.equal(waiting,1); assert.equal(connection.send({type:'edit'}),false);
    connection.dispose(); b.receive('opened'); assert.equal(opened,1);
    assert.equal(b.outbound.at(-1).operation,'disconnect');
  } finally { connection.dispose(); b.restore(); }
});

test('embedded flush waits for its own physical-send acknowledgement, not another session', async () => {
  const b = browser(); const connection = createEmbeddedConnection({token:'test',onOpen(){},onWaiting(){},onMessage(){}});
  try {
    b.receive('opened'); let settled = false;
    const flush = connection.flush(1000).then(() => { settled = true; });
    const requestId = b.outbound.at(-1).requestId;
    b.receive('flushed',{requestId:'other'}); await Promise.resolve(); assert.equal(settled,false);
    b.receive('flushed',{requestId}); await flush; assert.equal(settled,true);
    const pending = connection.flush(1000); connection.dispose(); await pending;
  } finally { connection.dispose(); b.restore(); }
});

test('sleep protects draft, modal, incomplete sync and local undo, but not remote-only changes', () => {
  const b = browser(); let changed, disposed = false, draft = false, modal = false, restored = 0;
  document.querySelector = selector => selector === 'dialog[open]' && modal ? {} : null;
  const state = {path:'/a',ready:false,applyingRemote:false,editingSuggestionId:''};
  const editor = {onDidChangeModelContent:callback => {changed = callback; return {dispose:() => {disposed = true;}};},
    saveViewState:() => ({position:2}),getPosition:() => ({lineNumber:2,column:3}),getScrollTop:() => 42,
    restoreViewState:() => restored++,setPosition(){},setScrollTop(){},layout(){}};
  const runtime = createWorkspaceRuntime({state,editor,hasDraft:() => draft,send(){},onVisible(){},close:async () => {}});
  const safe = () => { b.receive('prepareSleep'); return b.outbound.at(-1).safe; };
  try {
    b.receive('visibility',{visible:false}); assert.equal(safe(),false);
    b.receive('restore',{viewState:{position:2}}); assert.equal(restored,0);
    state.ready = true; runtime.ready(); assert.equal(restored,1); runtime.ready(); assert.equal(restored,1);
    assert.equal(safe(),true);
    state.applyingRemote = true; changed(); state.applyingRemote = false; assert.equal(safe(),true);
    draft = true; assert.equal(safe(),false); draft = false;
    modal = true; assert.equal(safe(),false); modal = false;
    b.receive('visibility',{visible:true}); assert.equal(safe(),false);
    b.receive('visibility',{visible:false}); changed(); assert.equal(safe(),false,'undo history must survive inactivity');
  } finally { runtime.dispose(); assert.equal(disposed,true); b.restore(); }
});
