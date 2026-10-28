import assert from 'node:assert/strict';
import test from 'node:test';
import { discussionMergeOrigin, mergeDiscussionMessages } from '../apps/server/src/branch-discussion-merge.mjs';
import { minimalCommentThread, minimalSuggestion } from '../apps/server/src/room-metadata.mjs';
import { MAX_DELETED_MESSAGE_IDS } from '../apps/server/src/document-review-policy.mjs';
import { createDiscussionOverflow } from '../apps/server/src/branch-discussion-overflow.mjs';
import { validateServerMessage } from '../packages/shared/src/protocol-schema.mts';

const origin = discussionMergeOrigin('feature:localisation/russian/file.yml');
const message = {id:'reply',body:'Base',authorId:'alice',author:'Alice',color:'#123456',createdAt:'2026-10-01'};
const thread = () => ({id:'thread',author:'Alice',color:'#123456',status:'open',startRelative:'start',endRelative:'end',messages:[structuredClone(message)]});

test('migration base survives metadata persistence and detects divergent edits after restart', () => {
  const source = thread(), target = thread();
  mergeDiscussionMessages(source,target,origin);
  const restored = minimalCommentThread(JSON.parse(JSON.stringify(target)));
  assert.deepEqual(restored.messages[0].branchMergeBase,target.messages[0].branchMergeBase);
  source.messages[0] = {...source.messages[0],body:'Source',revision:2};
  restored.messages[0] = {...restored.messages[0],body:'Target',revision:1};
  assert.equal(mergeDiscussionMessages(source,restored,origin),true);
  assert.equal(restored.messages[0].body,'Target');
  assert.deepEqual(restored.messages.slice(1).map(item=>[item.body,item.authorId,item.revision]),[['Source','alice',0]]);
  assert.match(restored.messages[1].id,/^merge-[0-9a-f]{32}$/u);
  assert.equal(mergeDiscussionMessages(source,restored,origin),false);
  assert.equal(restored.messages.length,2);
  restored.deletedMessageIds=[restored.messages[1].id];restored.messages.pop();
  assert.equal(mergeDiscussionMessages(source,restored,origin),false);
  assert.equal(restored.messages.length,1);
});

test('legacy copied messages with no base are conservative, while identical text may establish a base', () => {
  const source=thread(),target=thread();
  source.messages[0].body='Source';source.messages[0].revision=9;
  target.messages[0].body='Target';target.messages[0].revision=1;
  mergeDiscussionMessages(source,target,origin);
  assert.deepEqual(target.messages.map(item=>item.body),['Target','Source']);
  target.messages[0].body='Source';
  mergeDiscussionMessages(source,target,origin);
  assert.equal(target.messages[0].revision,1);
  source.messages[0].body='Source again';source.messages[0].revision=10;
  mergeDiscussionMessages(source,target,origin);
  assert.equal(target.messages[0].body,'Source again');
  assert.equal(target.messages[0].revision,11);
});

test('keeping a target-only edit does not erase the common base before a later source edit', () => {
  const source=thread(),target=thread();mergeDiscussionMessages(source,target,origin);
  target.messages[0].body='Target';target.messages[0].revision=1;
  const base=structuredClone(target.messages[0].branchMergeBase);
  mergeDiscussionMessages(source,target,origin);
  assert.deepEqual(target.messages[0].branchMergeBase,base);
  source.messages[0].body='Source';source.messages[0].revision=2;
  mergeDiscussionMessages(source,target,origin);
  assert.deepEqual(target.messages.map(item=>item.body),['Target','Source']);
});

test('deletion history in either branch prevents a live reply being restored during migration', () => {
  const source=thread(),target=thread();source.messages[0].id='gone';
  target.deletedMessageIds=['gone'];
  mergeDiscussionMessages(source,target,origin);
  assert.equal(target.messages.some(item=>item.id==='gone'),false);
  source.deletedMessageIds=['reply'];
  mergeDiscussionMessages(source,target,origin);
  assert.equal(target.messages[0].deleted,true);assert.equal(target.messages[0].body,'');
  assert.deepEqual(target.deletedMessageIds,['gone','reply']);
  assert.deepEqual(minimalSuggestion(target).deletedMessageIds,['gone','reply']);
});

test('deletion history is bounded and malformed wire metadata is rejected', () => {
  const source=thread(),target=thread();source.deletedMessageIds=Array.from({length:MAX_DELETED_MESSAGE_IDS+1},(_,i)=>`gone${i}`);
  mergeDiscussionMessages(source,target,origin);
  assert.equal(target.deletedMessageIds.length,MAX_DELETED_MESSAGE_IDS);
  assert.deepEqual(target.deletedMessageIdsRecovery,[`gone${MAX_DELETED_MESSAGE_IDS}`]);
  assert.equal(target.deletionHistoryBlocked,true);
  const review={type:'review',documentId:'file',commentThreads:[thread()],suggestions:[]};
  review.commentThreads[0].deletedMessageIds=['gone'];
  assert.doesNotThrow(()=>validateServerMessage(review));
  review.commentThreads[0].deletedMessageIds=[5];
  assert.throws(()=>validateServerMessage(review),/Deleted message id/);
  delete review.commentThreads[0].deletedMessageIds;
  review.commentThreads[0].messages[0].branchMergeBase={origin,source:'bad',target:origin};
  assert.throws(()=>validateServerMessage(review),/merge fingerprint/);
});

const numbered = index => ({id:`m${index}`,authorId:'alice',author:'Alice',color:'#123456',body:`Text ${index}`,createdAt:`2026-10-01T00:${String(index).padStart(3,'0')}`});
const crowded = (live, extra) => {
  const base = Array.from({length:live},(_,i)=>numbered(i));
  const target = {...thread(),messages:structuredClone(base)};
  const source = {...thread(),messages:[...structuredClone(base),...Array.from({length:extra},(_,i)=>numbered(500+i))]};
  return {source,target,threads:[target]};
};

test('new replies that do not fit a full discussion move to the overflow thread instead of blocking', () => {
  const {source,target,threads}=crowded(95,10);
  assert.throws(()=>mergeDiscussionMessages(source,structuredClone(target),origin),/message limit/);
  mergeDiscussionMessages(source,target,origin,{overflow:createDiscussionOverflow(threads,target,origin)});
  assert.equal(target.messages.length,100);
  assert.deepEqual(target.messages.slice(95).map(item=>item.id),['m500','m501','m502','m503','m504']);
  assert.equal(threads.length,2);
  assert.deepEqual(threads[1].messages.map(item=>item.id),['m505','m506','m507','m508','m509']);
  assert.equal(mergeDiscussionMessages(source,target,origin,{overflow:createDiscussionOverflow(threads,target,origin)}),false);
  assert.equal(threads[1].messages.length,5);
});

test('a damaged deletion ledger does not block migration; new replies move aside and old IDs stay blocked', () => {
  const {source,target,threads}=crowded(1,2);
  target.deletedMessageIds=Array.from({length:MAX_DELETED_MESSAGE_IDS},(_,i)=>`gone${i}`);
  target.deletedMessageIdsRecovery=['gone-extra'];target.deletionHistoryBlocked=true;
  source.messages.push({...numbered(900),id:'gone-extra'});
  mergeDiscussionMessages(source,target,origin,{overflow:createDiscussionOverflow(threads,target,origin)});
  assert.deepEqual(target.messages.map(item=>item.id),['m0']);
  assert.deepEqual(target.deletedMessageIdsRecovery,['gone-extra']);
  assert.deepEqual(threads[1].messages.map(item=>item.id),['m500','m501']);
});

test('overflow receipts beyond the wire bound spill into recovery instead of failing', () => {
  const {source,target,threads}=crowded(100,1);
  target.mergeOverflowIds=Array.from({length:MAX_DELETED_MESSAGE_IDS},(_,i)=>`receipt${i}`);
  mergeDiscussionMessages(source,target,origin,{overflow:createDiscussionOverflow(threads,target,origin)});
  assert.equal(target.mergeOverflowIds.length,MAX_DELETED_MESSAGE_IDS);
  assert.deepEqual(target.mergeOverflowIdsRecovery,['m500']);
  assert.equal(threads[1].messages[0].id,'m500');
  assert.equal(mergeDiscussionMessages(source,target,origin,{overflow:createDiscussionOverflow(threads,target,origin)}),false);
});

const movedReply = () => {
  const {source,target,threads}=crowded(100,1);
  const merge=()=>mergeDiscussionMessages(source,target,origin,{overflow:createDiscussionOverflow(threads,target,origin)});
  merge();
  assert.equal(threads[1].messages[0].body,'Text 500');
  return {source,target,threads,merge,reply:source.messages.at(-1)};
};

test('a retry carries a branch edit into a reply that was already moved to the overflow thread', () => {
  const {threads,merge,reply}=movedReply();
  Object.assign(reply,{body:'Edited in branch',revision:1,editedAt:'2026-10-27T10:00:00Z'});
  assert.equal(merge(),true);
  assert.equal(threads[1].messages[0].body,'Edited in branch');
  assert.equal(threads[1].messages.length,1);
  assert.equal(merge(),false);
});

test('a retry removes a moved reply deleted in the branch, but never restores a copy a user deleted', () => {
  for(const removal of ['tombstone','ledger']){
    const {source,threads,merge,reply}=movedReply();
    if(removal==='tombstone')Object.assign(reply,{body:'',deleted:true,revision:1});
    else{source.messages.pop();source.deletedMessageIds=[reply.id];}
    assert.equal(merge(),true);
    assert.equal(threads[1].messages[0].deleted,true);assert.equal(threads[1].messages[0].body,'');
  }
  const {threads,merge,reply}=movedReply();
  threads[1].messages=[];threads[1].deletedMessageIds=[reply.id];
  Object.assign(reply,{body:'Edited after the copy was deleted',revision:1});
  merge();
  assert.deepEqual(threads[1].messages,[]);assert.equal(threads.length,2);
  threads.pop();merge();assert.equal(threads.length,1);
});
