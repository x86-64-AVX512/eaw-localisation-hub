import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { discussionDraftScope,loadDiscussionDrafts,resumeDraftAsEdit,saveDiscussionDrafts } from '../apps/review/src/discussion-drafts.ts';
import { createReviewDocument } from '../apps/review/src/review-document.ts';
const state={draftScope:'server-and-repo',workspace:'branch',path:'C:/repo/file.yml',relativePath:'localisation/russian/file.yml',userId:'alice',ticket:null};
const draft={key:'new:one',kind:'new',target:'comment',id:'thread',messageId:'message',body:'Недописанный\n🦄',expectedRevision:0,startByte:2,endByte:12,reviewAnchors:'{}'};
test('local drafts survive a fresh store read and are isolated by user, server, branch, file and ticket',()=>{
 const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const scope=discussionDraftScope(state);saveDiscussionDrafts(storage,scope,[draft]);
 assert.deepEqual(loadDiscussionDrafts(storage,scope),[draft]);
 for(const fields of [{draftScope:'other-server'},{userId:'bob'},{workspace:'other'},{relativePath:'other.yml'},{ticket:{id:'ticket'}}]){
   const other=discussionDraftScope({...state,...fields});assert.notEqual(other,scope);assert.deepEqual(loadDiscussionDrafts(storage,other),[]);
 }
 saveDiscussionDrafts(storage,scope,[]);assert.equal(values.has(scope),false);
});
test('malformed draft storage is ignored and quota failures remain visible to the caller',()=>{
 for(const value of ['oops','{}',JSON.stringify([{...draft,startByte:-1}]),JSON.stringify([{...draft,body:1}]),JSON.stringify([{...draft,submittedBody:5}])])assert.deepEqual(loadDiscussionDrafts({getItem:()=>value},'scope'),[]);
 assert.throws(()=>saveDiscussionDrafts({setItem(){throw new Error('quota');},removeItem(){}},'scope',[draft]),/quota/);
 assert.equal(discussionDraftScope({...state,draftScope:''}),'');
});
test('a reply or new comment already stored with older text continues as an edit of that message',()=>{
 for(const kind of ['reply','new']){
   const value={...draft,kind,requestId:'request',submittedBody:'Old'};
   assert.equal(resumeDraftAsEdit(value,{status:'stale',revision:3}),true);
   assert.equal(value.kind,'edit');assert.equal(value.expectedRevision,3);assert.equal(value.requestId,undefined);assert.equal(value.submittedBody,undefined);
 }
 const edit={...draft,kind:'edit',expectedRevision:1,requestId:'request'};
 assert.equal(resumeDraftAsEdit(edit,{status:'stale',revision:4}),false);assert.equal(edit.expectedRevision,1);assert.equal(edit.requestId,'request');
 assert.equal(resumeDraftAsEdit({...draft,kind:'reply'},{status:'deleted'}),false);
 const saved={...draft,kind:'reply'};assert.equal(resumeDraftAsEdit(saved,{status:'saved'}),true);assert.equal(saved.expectedRevision,0);
});
test('a persisted draft anchor follows Unicode prefix edits and refuses another CRDT document',()=>{
 const doc=new Y.Doc(),text=doc.getText('content');text.insert(0,'before\nComment here\nafter');
 const browser=createReviewDocument({send(){},onText(){}});
 const sync=()=>browser.receive({documentId:'one',path:'x',updateBase64:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')});sync();
 const request=browser.anchor({type:'commentCreate',startByte:7,endByte:19});
 text.insert(0,'🦄\n');sync();
 assert.deepEqual(browser.resolveAnchors(request.reviewAnchors),{startByte:12,endByte:24});
 assert.equal(browser.resolveAnchors(JSON.stringify({...JSON.parse(request.reviewAnchors),documentId:'other'})),null);
 browser.dispose();doc.destroy();
});
