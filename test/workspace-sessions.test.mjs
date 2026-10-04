import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { attachReviewMultiplexer, reviewSleepBlocked } from '../apps/agent/src/review-multiplexer.mjs';
import { workspaceSleepCandidates, workspaceSleepSettings } from '../apps/review/src/workspace-sleep.ts';
import { AgentHub } from '../apps/agent/src/agent-hub.mjs';

const settled = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const physical = new EventEmitter(); physical.readyState = WebSocket.OPEN;
  const outbound = [], received = [], detached = [], clients = new Set();
  physical.send = text => outbound.push(JSON.parse(text));
  physical.close = code => { physical.code = code; physical.readyState = WebSocket.CLOSED; physical.emit('close'); };
  const hub = { clients, clientsById:new Map(),
    sendAgentHello:client => client.send({type:'agentHello',user:'Test',workspace:'main',color:'#abcdef'}),
    attachAuthenticatedClient:AgentHub.prototype.attachAuthenticatedClient,
    receiveClientMessage(client,message) { received.push({client,message});
      if (message.type === 'activate') client.activeDocumentPath = message.path;
      if (message.type === 'deactivate') client.activeDocumentPath = null;
    },
  };
  let serial = 0;
  const result = attachReviewMultiplexer(physical,hub,socket => {
    const client = {clientId:String(++serial),authenticated:true,closed:false,documents:new Map(),materialisationTimers:new Map(),
      activeDocumentPath:null,send:message => socket.send(JSON.stringify(message))};
    socket.on('message',(data) => hub.receiveClientMessage(client,JSON.parse(data)));
    socket.on('close',() => { client.closed = true; clients.delete(client); hub.clientsById.delete(client.clientId); detached.push(client); });
    return client;
  });
  const frame = (sessionId,operation,message) => physical.emit('message',Buffer.from(JSON.stringify({type:'reviewSession',sessionId,operation,message})),false);
  const open = id => { frame(id,'open'); return result.channels.get(id).client; };
  function clean(client) {
    const binding = {synced:true,personalReady:true,gitWritable:true,localFileText:() => 'text',flushToServer:async () => true};
    const state = {initialised:true,initialReconciled:true,diskBase:'text',diskCheckPromise:Promise.resolve(),binding};
    client.documents.set('/same.yml',state); return state;
  }
  return {physical,hub,outbound,received,detached,frame,open,clean,...result};
}

test('one physical Review socket routes separate same-file/ticket sessions without cross-talk', () => {
  const f = fixture(), main = f.open('main'), ticket = f.open('ticket');
  assert.equal(main.connectionId,ticket.connectionId);
  assert.notEqual(main.clientId,ticket.clientId);
  f.frame('main','message',{type:'open',path:'/same.yml'});
  f.frame('ticket','message',{type:'open',path:'/same.yml',ticketId:'ticket'});
  assert.equal(f.received[0].client,main); assert.equal(f.received[1].client,ticket);
  main.send({type:'replace',path:'/same.yml',insertBase64:'MAIN'});
  ticket.send({type:'replace',path:'/same.yml',insertBase64:'TICKET'});
  assert.deepEqual(f.outbound.slice(-2).map(m => [m.sessionId,m.message.insertBase64]),[['main','MAIN'],['ticket','TICKET']]);
  f.frame('main','close'); assert.equal(main.closed,true); assert.equal(ticket.closed,false);
  assert.equal(f.physical.readyState,WebSocket.OPEN);
});

test('only the selected document publishes presence; inactive document edits still reach their own binding', () => {
  const f = fixture(), a = f.open('a'), b = f.open('b');
  f.frame('a','select'); f.frame('a','message',{type:'activate',path:'/a'});
  f.frame('b','select');
  assert.equal(a.activeDocumentPath,null);
  f.frame('a','message',{type:'cursor',path:'/a'});
  f.frame('a','message',{type:'activate',path:'/a'});
  f.frame('a','message',{type:'reviewUpdate',path:'/a'});
  f.frame('b','message',{type:'activate',path:'/b'});
  assert.equal(f.received.filter(item => item.message.type === 'cursor').length,0);
  assert.equal(f.received.at(-2).client,a); assert.equal(f.received.at(-1).client,b);
  assert.equal(b.activeDocumentPath,'/b');
});

test('sleep requires a second Agent check and server flush, detaches only that subscription', async () => {
  const f = fixture(), a = f.open('a'), b = f.open('b');
  f.clean(a); f.clean(b); f.frame('b','select'); f.frame('a','sleep'); await settled();
  assert.equal(a.closed,true); assert.equal(b.closed,false); assert.equal(f.channels.size,1);
  assert.deepEqual(f.outbound.at(-1),{type:'reviewSessionClosed',sessionId:'a',reason:'sleep'});
  const awake = f.open('a-new'); assert.notEqual(awake.clientId,a.clientId);
});

test('reactivating or modifying a document while sleep flush is pending cancels eviction', async () => {
  for (const operation of ['select','message']) {
    const f = fixture(), a = f.open('a'); const state = f.clean(a); let release;
    state.binding.flushToServer = () => new Promise(resolve => { release = resolve; });
    f.frame('other','select'); f.frame('a','sleep'); await settled();
    f.frame('a',operation,{type:'reviewUpdate',path:'/same.yml'}); release(true); await settled();
    assert.equal(a.closed,false,operation);
    assert.equal(f.outbound.at(-1).type,'reviewSessionSleepDenied');
  }
});

test('changes detected during disk reconciliation or failed server acknowledgement prevent sleep', async () => {
  for (const change of ['disk','flush']) {
    const f = fixture(), a = f.open('a'), state = f.clean(a);
    if (change === 'disk') state.diskCheckPromise = Promise.resolve().then(() => { state.pendingExternal = {}; });
    else state.binding.flushToServer = async () => false;
    f.frame('other','select'); f.frame('a','sleep'); await settled();
    assert.equal(a.closed,false); assert.equal(f.outbound.at(-1).type,'reviewSessionSleepDenied');
  }
});

test('unsafe materialisation, conflicts, recovery, branch transition and incomplete sync cannot sleep', () => {
  for (const [where,field,value] of [
    ['hub','workspaceBlocked',true],['hub','workspaceTransitioning',true],['hub','gitCommitCheckPending',true],
    ['client','closed',true],['state','initialised',false],['state','initialReconciled',false],['state','pendingExternal',{}],
    ['binding','synced',false],['binding','paused',true],['binding','localUpdatePending',true],['binding','deliveryFailed',true],
    ['binding','flushWaiter',{}],['binding','personalRequestId','request'],['binding','personalReady',false],
    ['binding','personalRefreshPending',true],['binding','personalRefreshTimer',{}],['binding','materialisationActive',true],
    ['binding','personalConflicts',[{}]],['binding','personalGitConflicts',[{}]],['binding','personalSelectionStale',true],
    ['binding','gitState',{status:'conflict'}],['binding','socket',{bufferedAmount:1}],
  ]) {
    const f = fixture(), client = f.open('a'), state = f.clean(client);
    ({hub:f.hub,client,state,binding:state.binding})[where][field] = value;
    assert.equal(reviewSleepBlocked(client,f.hub),true,`${where}.${field}`);
  }
  const f = fixture(), client = f.open('a'), state = f.clean(client);
  state.binding.localFileText = () => 'not saved'; assert.equal(reviewSleepBlocked(client,f.hub),true);
  state.binding.localFileText = () => 'text'; client.materialisationTimers.set('/same.yml',1);
  assert.equal(reviewSleepBlocked(client,f.hub),true);
});

test('a failed sleep flush does not disconnect the workspace or its other documents', async () => {
  const f = fixture(), a = f.open('a'), b = f.open('b'), state = f.clean(a);
  f.clean(b); f.frame('b','select');
  state.binding.flushToServer = async () => { throw new Error('Disconnected'); };
  f.frame('a','sleep'); await settled();
  assert.equal(a.closed,false); assert.equal(b.closed,false);
  assert.equal(f.physical.readyState,WebSocket.OPEN);
  assert.equal(f.outbound.at(-1).type,'reviewSessionSleepDenied');
});

test('logical session limit and eight physical-connection limit are independent', () => {
  const f = fixture();
  for (let i = 0;i < 20;i++) f.open(`doc-${i}`);
  f.frame('doc-0','open'); assert.equal(f.channels.size,20,'duplicate opens are idempotent');
  f.frame('extra','open'); assert.equal(f.channels.size,20); assert.equal(f.outbound.at(-1).reason,'limit');
  const others = Array.from({length:7},(_,i) => ({clientId:`outside-${i}`,authenticated:true,send(){}}));
  for (const client of others) assert.equal(f.hub.attachAuthenticatedClient(client),true);
  assert.equal(f.hub.attachAuthenticatedClient({clientId:'ninth',authenticated:true}),false);
  f.physical.close(1000); assert.equal(f.detached.length,20); assert.equal(f.channels.size,0);
});

test('malformed or binary workspace envelopes close the physical socket and release all sessions', () => {
  for (const malformed of [{type:'other',sessionId:'a',operation:'open'}, {type:'reviewSession',sessionId:'../a',operation:'open'},
    {type:'reviewSession',sessionId:'a',operation:'unknown'}]) {
    const f = fixture(); f.open('a'); f.physical.emit('message',Buffer.from(JSON.stringify(malformed)),false);
    assert.equal(f.physical.code,1008); assert.equal(f.channels.size,0);
  }
});

test('sleep settings validate persistent inputs and preserve a safe default', () => {
  assert.deepEqual(workspaceSleepSettings(null),{enabled:true,idleMinutes:5,warmLimit:4});
  assert.deepEqual(workspaceSleepSettings({enabled:false,idleMinutes:30,warmLimit:20}),{enabled:false,idleMinutes:30,warmLimit:20});
  assert.deepEqual(workspaceSleepSettings({idleMinutes:-1,warmLimit:100}),{enabled:true,idleMinutes:5,warmLimit:4});
});

test('idle and LRU pressure sleep never evict active, protected or pending documents', () => {
  const now = 600_000;
  const sessions = Array.from({length:8},(_,i) => ({id:String(i),lastUsed:i*60_000,protected:false,pending:false}));
  sessions[0].protected = true; sessions[1].pending = true;
  assert.deepEqual(workspaceSleepCandidates(sessions,'2',workspaceSleepSettings(null),now).map(s => s.id),['3','4','5','6']);
  assert.equal(workspaceSleepCandidates(sessions,'2',workspaceSleepSettings({enabled:false}),now).length,0);
  assert.equal(workspaceSleepCandidates([{id:'old',lastUsed:now-59_999,protected:false,pending:false}], 'active',
    {enabled:true,idleMinutes:1,warmLimit:0},now).length,0,'pressure cannot sleep newly used documents');
});
