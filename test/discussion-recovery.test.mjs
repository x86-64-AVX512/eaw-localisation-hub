import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { minimalCommentThread, minimalSuggestion, publicDiscussionItems, minimisePersistedDocumentMetadata } from '../apps/server/src/room-metadata.mjs';
import { DocumentRoom, closeDocumentRoomValidator } from '../apps/server/src/document-room.mjs';
import { validateServerMessage } from '../packages/shared/src/protocol-schema.mts';
after(closeDocumentRoomValidator);
const ids=Array.from({length:4097},(_,i)=>`gone${i}`);
const thread=()=>({id:'thread',authorId:'alice',author:'Alice',color:'#123456',status:'open',startRelative:'s',endRelative:'e',messages:[{id:'root',authorId:'alice',author:'Alice',color:'#123456',body:'Root'}],deletedMessageIds:ids});

test('excess valid deletion IDs survive normalisation and JSON reload while wire history stays bounded',()=>{
  let saved=minimalCommentThread(thread());
  for(let i=0;i<3;i++)saved=minimalCommentThread(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual([...saved.deletedMessageIds,...saved.deletedMessageIdsRecovery],ids);
  assert.equal(saved.deletionHistoryBlocked,true);
  const visible=publicDiscussionItems([saved]);
  assert.equal(visible[0].deletedMessageIdsRecovery,undefined);assert.equal(visible[0].deletedMessageIds.length,4096);
  assert.doesNotThrow(()=>validateServerMessage({type:'review',documentId:'x',commentThreads:visible,suggestions:[]}));
  assert.deepEqual(minimalSuggestion(saved).deletedMessageIdsRecovery,['gone4096']);
});

test('recovery blocks late resurrection and new replies only in the affected discussion',()=>{
  const saved=minimalCommentThread(thread()),healthy={...thread(),id:'healthy',deletedMessageIds:[]};
  const actor={id:'alice',displayName:'Alice',roles:['translator']};
  const room=Object.assign(Object.create(DocumentRoom.prototype),{destroyed:false,documentId:'branch:localisation/russian/test.yml',
    authStore:{required:true},registry:{isUnavailableBranch:()=>false},commentThreads:[saved,healthy],suggestions:[],reservations:[],
    actorFor:()=>actor,assertMetadataBudget(){},schedulePersist(){},broadcastReview(){},notifyTicketOwner(){}});
  const socket={identity:actor,readyState:1};
  for(const messageId of ['gone0','gone4096'])assert.equal(room.applyJson(socket,{type:'comment-reply',id:'thread',messageId,body:'Old',requestId:'retry'}).status,'deleted');
  assert.throws(()=>room.applyJson(socket,{type:'comment-reply',id:'thread',messageId:'new',body:'New'}),/deletion history limit/);
  assert.equal(room.applyJson(socket,{type:'comment-reply',id:'healthy',messageId:'new',body:'New'}).status,'saved');
  assert.equal(saved.messages.length,1);
});

test('overflow receipts are also recovered without blocking startup or forgetting transferred versions',()=>{
  let saved=minimalCommentThread({...thread(),deletedMessageIds:[],mergeOverflowIds:ids});
  assert.equal(saved.mergeOverflowBlocked,true);
  saved=minimalCommentThread({...saved,mergeOverflowIds:undefined});
  assert.deepEqual(saved.mergeOverflowIds,['gone4096']);
  assert.equal(saved.mergeOverflowBlocked,true);
  const visible=publicDiscussionItems([minimalCommentThread({...thread(),mergeOverflowIds:ids})]);
  assert.equal(visible[0].mergeOverflowIdsRecovery,undefined);
  assert.equal(visible[0].mergeOverflowIds.length,4096);
});

test('startup metadata cleanup preserves the recovery ledger across repeated runs',async context=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'eaw-deletion-recovery-'));context.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'documents'));
  const file=path.join(root,'documents','a'.repeat(64)+'.json');
  await fs.writeFile(file,JSON.stringify({schema:3,commentThreads:[thread()],suggestions:[],reservations:[]}));
  for(let i=0;i<2;i++)await minimisePersistedDocumentMetadata(root,(target,data)=>fs.writeFile(target,data));
  const saved=JSON.parse(await fs.readFile(file,'utf8')).commentThreads[0];
  assert.deepEqual([...saved.deletedMessageIds,...saved.deletedMessageIdsRecovery],ids);
  assert.equal(saved.deletionHistoryBlocked,true);
});
