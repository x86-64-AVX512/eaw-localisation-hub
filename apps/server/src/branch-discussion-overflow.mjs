import crypto from 'node:crypto';
import { withRoomForMessages, MAX_DELETED_MESSAGE_IDS } from './document-review-policy.mjs';

const receiptsOf = parent => new Set([...(parent.mergeOverflowIds ?? []), ...(parent.mergeOverflowIdsRecovery ?? [])]);

// All inputs belong to the migration's cloned target list, so budget failures
// discard both the overflow thread and its receipt without touching live rooms.
export function createDiscussionOverflow(threads, parent, origin) {
  const own = () => threads.filter(thread => thread.mergeOverflowParent === parent.id && thread.mergeOverflowOrigin === origin);
  return {
    contains(id) { return receiptsOf(parent).has(id); },
    // A moved copy that is still present, live or as a tombstone. A copy a user deleted
    // and that was compacted away, or whose whole overflow thread was deleted, is absent.
    find(id) {
      for (const thread of own()) {
        const index = thread.messages.findIndex(message => message.id === id);
        if (index >= 0) return { thread, index };
      }
      return null;
    },
    state() { return JSON.stringify(own()); },
    append(message) {
      const receipts = receiptsOf(parent);
      if (receipts.has(message.id)) return;
      let destination, compacted;
      for (const thread of threads) {
        if (thread.mergeOverflowParent !== parent.id || thread.mergeOverflowOrigin !== origin
          || thread.deletionHistoryBlocked || thread.deletedMessageIdsRecovery?.length) continue;
        try { compacted = withRoomForMessages(thread, 1); }
        catch (error) {
          if (error.message !== 'This discussion has reached its deletion history limit') throw error;
          continue; // A full deletion ledger cannot be pruned to make space.
        }
        if (compacted) { destination = thread; break; }
      }
      if (!destination) {
        const id = 'merge-thread-' + crypto.createHash('sha256').update(JSON.stringify([origin,parent.id,message.id])).digest('hex').slice(0,32);
        if (threads.some(thread => thread.id === id)) throw new Error('Merged discussion overflow id already exists');
        destination = {
          id, authorId: message.authorId ?? null, author: message.author, color: message.color ?? parent.color,
          createdAt: message.createdAt, status: 'open', messages: [],
          startRelative: parent.startRelative, endRelative: parent.endRelative,
          ...(parent.anchorLocator ? {anchorLocator: structuredClone(parent.anchorLocator)} : {}),
          ...(parent.orphaned ? {orphaned:true} : {}),
          mergeOverflowParent: parent.id, mergeOverflowOrigin: origin,
        };
        threads.push(destination);
        compacted = {messages:[],deletedMessageIds:[]};
      }
      destination.messages = [...compacted.messages, structuredClone(message)];
      destination.deletedMessageIds = compacted.deletedMessageIds;
      receipts.add(message.id);
      // Like the deletion ledger, receipts beyond the wire bound stay in recovery.
      const ids = [...receipts];
      parent.mergeOverflowIds = ids.slice(0, MAX_DELETED_MESSAGE_IDS);
      if (ids.length > MAX_DELETED_MESSAGE_IDS) {
        parent.mergeOverflowIdsRecovery = ids.slice(MAX_DELETED_MESSAGE_IDS);
        parent.mergeOverflowBlocked = true;
      }
    },
  };
}
