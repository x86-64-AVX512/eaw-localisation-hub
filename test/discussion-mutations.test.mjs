import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { mkdtemp,readFile,rm,mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as Y from 'yjs';
import { DocumentRoom,closeDocumentRoomValidator } from '../apps/server/src/document-room.mjs';
import { RoomRegistry } from '../apps/server/src/room-registry.mjs';
import { applyDiscussionControl } from '../apps/server/src/discussion-control.mjs';
import { minimalCommentThread,minimalDiscussionMessage } from '../apps/server/src/room-metadata.mjs';
import { MAX_DELETED_MESSAGE_IDS } from '../apps/server/src/document-review-policy.mjs';
import { mutateDiscussion,createComment,receiveDiscussionResult } from '../apps/agent/src/discussion-actions.mjs';
import { validateClientMessage,validateServerMessage } from '../packages/shared/src/protocol-schema.mts';
after(closeDocumentRoomValidator);
function harness(){
 const messages=[],broadcasts=[];
 const alice={id:'alice',displayName:'Alice',roles:['mod-contributor']};
 const room=Object.assign(Object.create(DocumentRoom.prototype),{destroyed:false,documentId:'branch:localisation/russian/file.yml',
   authStore:{required:true},registry:{isUnavailableBranch:()=>false},messageQueue:Promise.resolve(),
   commentThreads:[{id:'thread',authorId:'alice',messages:[{id:'root',authorId:'alice',author:'Alice',body:'Root',createdAt:'2026-10-01'},
     {id:'reply',authorId:'alice',author:'Alice',body:'Reply',createdAt:'2026-10-02'}]}],suggestions:[],reservations:[],
   actorFor:socket=>socket.identity,assertMetadataBudget(){},schedulePersist(){},persist:async()=>{},
   broadcastReview(){broadcasts.push(structuredClone(this.commentThreads));}});
 const socket={identity:alice,readyState:1,bufferedAmount:0,send:json=>messages.push(validateServerMessage(JSON.parse(json)))};
 return {room,socket,messages,broadcasts};
}
const command=(fields={})=>({type:'discussion-message-update',id:'thread',target:'comment',messageId:'reply',requestId:'request',expectedRevision:0,body:'Edited',...fields});
test('editing a message preserves its author/date, marks edits, rejects stale saves and persists revision metadata',()=>{
 const {room,socket}=harness();assert.equal(room.applyJson(socket,command()).status,'saved');
 const reply=room.commentThreads[0].messages[1];assert.equal(reply.authorId,'alice');assert.equal(reply.createdAt,'2026-10-02');assert.ok(reply.editedAt);assert.equal(reply.revision,1);
 assert.equal(minimalDiscussionMessage(reply).revision,1);
 assert.equal(room.applyJson(socket,command({requestId:'stale',body:'Wrong'})).status,'stale');assert.equal(reply.body,'Edited');
 assert.equal(room.applyJson(socket,command()).status,'saved');assert.equal(reply.revision,1);
 assert.equal(room.applyJson(socket,command({body:'Different same request'})).status,'stale');
 assert.equal(room.applyJson(socket,command({type:'discussion-message-delete'})).status,'stale');
 room.applyJson(socket,command({messageId:'root',requestId:'root-edit',body:'New root'}));assert.equal(room.commentThreads[0].messages[0].body,'New root');
});
test('deleting one reply leaves its thread and other messages; a tombstone blocks late replay',()=>{
 const {room,socket}=harness();assert.equal(room.applyJson(socket,command({type:'discussion-message-delete'})).status,'saved');
 const thread=room.commentThreads[0];assert.equal(thread.messages[0].body,'Root');assert.equal(thread.messages[1].deleted,true);assert.equal(thread.messages[1].body,'');
 assert.equal(room.applyJson(socket,command({requestId:'late'})).status,'deleted');
 assert.throws(()=>room.applyJson(socket,command({type:'discussion-message-delete',messageId:'root'})),/whole discussion/);
});
test('matching display names cannot edit someone else; only moderators may delete another author reply',()=>{
 const {room,socket}=harness();socket.identity={id:'bob',displayName:'Alice',roles:['translator']};
 assert.throws(()=>room.applyJson(socket,command()),/author/);assert.throws(()=>room.applyJson(socket,command({type:'discussion-message-delete'})),/author/);
 socket.identity.roles=['admin'];assert.throws(()=>room.applyJson(socket,command()),/author/);
 assert.equal(room.applyJson(socket,command({type:'discussion-message-delete'})).status,'saved');
});
test('moderation uses current roles and suggestion replies use the same author/revision controls',()=>{
 const {room,socket}=harness();
 room.authStore.state={users:[{id:'bob',enabled:true,roles:['translator']} ]};
 socket.identity={id:'bob',displayName:'Bob',roles:['admin']};
 assert.throws(()=>room.applyJson(socket,command({type:'discussion-message-delete'})),/author/);
 room.authStore.state.users[0].roles=['senior translator'];
 assert.equal(room.applyJson(socket,command({type:'discussion-message-delete'})).status,'saved');
 room.authStore.state.users.push({id:'alice',enabled:true,roles:['mod-contributor']});
 socket.identity={id:'alice',displayName:'Alice',roles:['mod-contributor']};
 room.suggestions=[{id:'suggestion',messages:[{id:'answer',authorId:'alice',body:'Answer',createdAt:'2026-10-02'}]}];
 assert.equal(room.applyJson(socket,command({id:'suggestion',target:'suggestion',messageId:'answer'})).revision,1);
 assert.equal(room.applyJson(socket,command({id:'suggestion',target:'suggestion',messageId:'answer',type:'discussion-message-delete',requestId:'delete-suggestion',expectedRevision:1})).status,'saved');
 assert.equal(room.suggestions[0].messages[0].deleted,true);
});
test('invalid bodies and metadata budget failures leave messages unchanged',()=>{
 const {room,socket}=harness(),before=structuredClone(room.commentThreads);
 for(const body of ['   ','я'.repeat(1025)]){assert.throws(()=>room.applyJson(socket,command({body})));assert.deepEqual(room.commentThreads,before);}
 room.assertMetadataBudget=()=>{throw new Error('budget');};assert.throws(()=>room.applyJson(socket,command()),/budget/);assert.deepEqual(room.commentThreads,before);
});
test('queued replies confirm only after durable persistence, return stale revisions, and retain errors on disk failure',async()=>{
 const {room,socket,messages}=harness();let release;room.persist=()=>new Promise(resolve=>release=resolve);
 const pending=room.receiveJson(socket,command());await new Promise(resolve=>setImmediate(resolve));assert.equal(messages.length,0);release();await pending;assert.equal(messages[0].status,'saved');
 room.persist=async()=>{};await room.receiveJson(socket,command({requestId:'two',body:'Stale'}));assert.equal(messages.at(-1).status,'stale');
 room.persist=async()=>{throw new Error('disk unavailable');};await room.receiveJson(socket,command({requestId:'three',expectedRevision:1,body:'Safe draft'}));
 assert.equal(messages.at(-1).status,'error');assert.equal(messages.at(-1).message,'Не удалось сохранить сообщение. Черновик сохранён.');
 room.persist=async()=>{};await room.receiveJson(socket,command({requestId:'three',expectedRevision:1,body:'Safe draft'}));assert.equal(messages.at(-1).status,'saved');
});
test('discussion write errors reach Review in the Russian source language',async()=>{
 const {room,socket,messages}=harness();socket.identity={id:'bob',displayName:'Bob',roles:['translator']};
 await room.receiveJson(socket,command());
 assert.equal(messages.at(-1).message,'Изменять сообщение может только его автор; удалять чужие ответы могут модераторы.');
 socket.identity={id:'alice',displayName:'Alice',roles:['mod-contributor']};
 await room.receiveJson(socket,command({type:'discussion-message-delete',messageId:'root',requestId:'root-delete'}));
 assert.equal(messages.at(-1).message,'Первое сообщение удаляется только вместе со всем обсуждением.');
});
test('compacted tombstones keep their IDs and block late replay while allowing 100 live messages',()=>{
 const {room,socket}=harness();const thread=room.commentThreads[0];
 thread.messages=Array.from({length:100},(_,index)=>({id:`m${index}`,authorId:'alice',author:'Alice',body:index===1||index===2?'':'Text',
   ...(index===1||index===2?{deleted:true}:{}),createdAt:'2026-10-01'}));
 assert.equal(room.applyJson(socket,{type:'comment-reply',id:'thread',messageId:'new',body:'New'}).status,'saved');
 assert.equal(thread.messages.length,100);assert.equal(thread.messages.some(item=>item.id==='m1'),false);assert.equal(thread.messages[1].id,'m2');
 assert.equal(thread.messages.at(-1).id,'new');
 assert.deepEqual(thread.deletedMessageIds,['m1']);
 for(const requestId of ['old-request',undefined])assert.equal(room.applyJson(socket,{type:'comment-reply',id:'thread',messageId:'m1',body:'Deleted text',requestId}).status,'deleted');
 assert.equal(thread.messages.some(item=>item.id==='m1'),false);
 thread.messages[1]={...thread.messages[1],deleted:false,body:'Live'};
 assert.throws(()=>room.applyJson(socket,{type:'comment-reply',id:'thread',messageId:'full',body:'Full'}),/message limit/);
});
test('full deletion history or a metadata failure never discards deletion IDs',()=>{
 const {room,socket}=harness();room.notifyTicketOwner=()=>{};const thread=room.commentThreads[0];
 thread.messages=Array.from({length:100},(_,index)=>({id:`m${index}`,authorId:'alice',body:index===1?'':'Text',...(index===1?{deleted:true}:{})}));
 thread.deletedMessageIds=Array.from({length:MAX_DELETED_MESSAGE_IDS},(_,index)=>`gone${index}`);
 const before=structuredClone(thread);
 assert.throws(()=>room.applyJson(socket,{type:'comment-reply',id:'thread',messageId:'new',body:'New'}),/deletion history limit/);
 assert.deepEqual(thread,before);
 thread.deletedMessageIds=[];const beforeBudget=structuredClone(thread);
 room.assertMetadataBudget=()=>{throw new Error('budget');};
 assert.throws(()=>room.applyJson(socket,{type:'comment-reply',id:'thread',messageId:'new',body:'New'}),/budget/);
 assert.deepEqual(thread,beforeBudget);
});
test('discussion metadata survives a real write/reload without restoring a deleted body',async context=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'eaw-discussion-save-'));context.after(()=>rm(root,{recursive:true,force:true}));
 const registry=new RoomRegistry(root,{required:false},null,async(target,data)=>{await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data);});
 const room=new DocumentRoom(root,'branch:localisation/russian/file.yml','discussion-save',{required:false},registry);
 const {room:fake,socket}=harness();room.commentThreads=fake.commentThreads;room.actorFor=peer=>peer.identity;
 room.commentThreads[0].deletedMessageIds=['old-deleted-id'];
 room.applyJson(socket,command({type:'discussion-message-delete'}));await room.flush();
 const saved=JSON.parse(await readFile(path.join(root,'documents/discussion-save.json'),'utf8'));
 assert.equal(saved.commentThreads[0].messages[1].deleted,true);assert.equal(saved.commentThreads[0].messages[1].body,'');room.destroy();
 const restored=new DocumentRoom(root,'branch:localisation/russian/file.yml','discussion-save',{required:false},registry);
 await restored.loadFromDisk();
 assert.equal(restored.commentThreads[0].messages[1].deleted,true);
 assert.equal(restored.commentThreads[0].messages[1].revision,1);
 assert.equal(restored.commentThreads[0].messages[0].body,'Root');
 assert.deepEqual(restored.commentThreads[0].deletedMessageIds,['old-deleted-id']);
 assert.equal(restored.applyJson(socket,{type:'comment-reply',id:'thread',messageId:'old-deleted-id',requestId:'retry',body:'Old body'}).status,'deleted');restored.destroy();
});
test('Agent keeps stable ids and correlates acknowledgements with the requesting Review only',()=>{
 const document=new Y.Doc(),text=document.getText('content');text.insert(0,'abc');const sent=[],first=[],second=[];
 const binding={document,text,synced:true,discussionUpdates:true,requireState:()=>({mirror:'abc'}),hub:{options:{user:'Alice',color:'#123456'}},socket:{readyState:1,send:value=>sent.push(JSON.parse(value))}};
 const client={send:value=>first.push(value)},other={send:value=>second.push(value)};
 createComment(binding,client,'one',{type:'commentCreate',id:'stable',messageId:'message',requestId:'create',startByte:0,endByte:1,bodyBase64:Buffer.from('body').toString('base64')});
 assert.equal(sent[0].id,'stable');assert.equal(sent[0].messageId,'message');
 receiveDiscussionResult(binding,{type:'discussion-result',requestId:'create',id:'stable',status:'saved'});assert.equal(first[0].path,'one');assert.deepEqual(second,[]);
 binding.synced=false;mutateDiscussion(binding,other,'two',{type:'discussionMessageDelete',id:'stable',messageId:'message',requestId:'delete',target:'comment',expectedRevision:0});assert.equal(second[0].status,'error');document.destroy();
});
test('malformed persisted deletion history is cleaned instead of stopping server startup',()=>{
 const thread={id:'thread',author:'Alice',startRelative:'s',endRelative:'e',messages:[],deletedMessageIds:['gone',5,'','x'.repeat(129),'gone','kept']};
 assert.deepEqual(minimalCommentThread(thread).deletedMessageIds,['gone','kept']);
 assert.equal(minimalCommentThread({...thread,deletedMessageIds:'oops'}).deletedMessageIds,undefined);
});
