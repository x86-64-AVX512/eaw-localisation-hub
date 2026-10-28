import crypto from 'node:crypto';
import { minimalDiscussionMessage } from './room-metadata.mjs';
import { withRoomForMessages, MAX_DELETED_MESSAGE_IDS, MAX_DISCUSSION_MESSAGES } from './document-review-policy.mjs';

export const discussionMergeOrigin = documentId => crypto.createHash('sha256').update(documentId).digest('hex');

function version(message) {
  const { branchMergeBase, ...snapshot } = minimalDiscussionMessage(message);
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function sameContent(left, right) {
  return left.body === right.body && (left.authorId ?? null) === (right.authorId ?? null)
    && (left.createdAt ?? '') === (right.createdAt ?? '') && Boolean(left.deleted) === Boolean(right.deleted);
}

function recordBase(target, source, origin) {
  target.branchMergeBase = { origin, source: version(source), target: version(target) };
}

const deletionLedger = item => [...(item.deletedMessageIds ?? []), ...(item.deletedMessageIdsRecovery ?? [])];

// Keeps the wire ledger bounded; the remainder stays in recovery, which still blocks
// late replays but marks the discussion as damaged for further new messages.
function writeDeletionLedger(target, deleted) {
  const ids = [...deleted];
  target.deletedMessageIds = ids.slice(0, MAX_DELETED_MESSAGE_IDS);
  if (ids.length > MAX_DELETED_MESSAGE_IDS) {
    target.deletedMessageIdsRecovery = ids.slice(MAX_DELETED_MESSAGE_IDS);
    target.deletionHistoryBlocked = true;
  } else delete target.deletedMessageIdsRecovery;
}

function replaceMessage(source, target, origin) {
  const revision = Math.max(source.revision ?? 0, target.revision ?? 0);
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Discussion revision exhausted');
  const copy = { ...structuredClone(source), revision: revision + 1 };
  recordBase(copy, source, origin);
  return copy;
}

// Brings a stored copy up to date with its source message. Returns the message to keep
// in its place, or null when both sides changed independently.
function reconcile(message, current, origin) {
  // Deletion remains final, including deletion history compacted in either room.
  if (current.deleted) return current;
  if (message.deleted) return replaceMessage(message, current, origin);
  if (sameContent(message, current)) {
    recordBase(current, message, origin);
    return current;
  }
  const base = current.branchMergeBase;
  if (base?.origin === origin && version(message) === base.source) return current;
  if (base?.origin === origin && version(current) === base.target) return replaceMessage(message, current, origin);
  return null;
}

// Called on a cloned thread. A failure leaves both original rooms untouched. Messages
// the target cannot take (full, or a damaged deletion ledger) go to the overflow thread,
// so neither a full nor a damaged discussion blocks the branch migration.
export function mergeDiscussionMessages(source, target, origin, { overflow = null, onConflict = (_id) => {} } = {}) {
  const before = JSON.stringify(target) + (overflow?.state() ?? '');
  const deleted = new Set([...deletionLedger(target), ...deletionLedger(source)]);
  // A reply deleted in the branch after it was moved aside must not survive in the copy.
  for (const id of deleted) {
    const moved = overflow?.find(id);
    const copy = moved?.thread.messages[moved.index];
    if (copy && !copy.deleted) moved.thread.messages[moved.index] = replaceMessage({ ...copy, body: '', deleted: true }, copy, origin);
  }
  target.messages ??= [];
  target.messages = target.messages.map(message => {
    if (!deleted.has(message.id) || message.deleted) return message;
    return replaceMessage({ ...message, body: '', deleted: true }, message, origin);
  });
  const known = new Map(target.messages.map((message, index) => [message.id, index]));
  const missing = [];
  const conflicts = [];
  for (const message of source.messages ?? []) {
    if (deleted.has(message.id)) continue;
    const index = known.get(message.id);
    let current = index === undefined ? null : target.messages[index];
    let moved = null;
    if (!current && overflow?.contains(message.id)) {
      moved = overflow.find(message.id);
      // The copy was deleted by a user in the target room: never restore it.
      if (!moved) continue;
      current = moved.thread.messages[moved.index];
    }
    if (!current) {
      if (message.deleted) deleted.add(message.id);
      else {
        const copy = structuredClone(message);
        recordBase(copy, message, origin);
        missing.push(copy);
      }
      continue;
    }
    const kept = reconcile(message, current, origin);
    if (kept && moved) moved.thread.messages[moved.index] = kept;
    else if (kept) target.messages[index] = kept;
    if (kept) continue;
    // Local revision counters from separate rooms cannot establish causality, and a
    // blocked migration would strand the branch's tickets. Keep the target text and add
    // the source text beside it; the id follows the source version, so retries stay idempotent.
    const conflictId = `merge-${version(message).slice(0, 32)}`;
    if (known.has(conflictId) || deleted.has(conflictId) || overflow?.contains(conflictId)
      || conflicts.some(item => item.id === conflictId)) continue;
    const { lastMutationId, branchMergeBase, ...conflict } = structuredClone(message);
    conflicts.push({ ...conflict, id: conflictId, revision: 0, mergeConflict: true });
  }
  writeDeletionLedger(target, deleted);
  const damaged = Boolean(target.deletionHistoryBlocked || target.deletedMessageIdsRecovery?.length);
  const capacity = damaged ? 0 : MAX_DISCUSSION_MESSAGES - target.messages.filter(message => !message.deleted).length;
  let accepted = [...missing, ...conflicts];
  let spilled = accepted.splice(Math.max(capacity, 0));
  let compacted = null;
  if (accepted.length) {
    try { compacted = withRoomForMessages(target, accepted.length); }
    catch (error) { if (error.message !== 'This discussion has reached its deletion history limit') throw error; }
    // Evicting tombstones would overfill the ledger: move everything aside instead.
    if (!compacted) { spilled = [...accepted, ...spilled]; accepted = []; }
  }
  if (spilled.length && !overflow) throw new Error('Merged discussion exceeds the target message limit');
  for (const message of spilled) overflow.append(message);
  if (compacted) {
    target.messages = [...compacted.messages, ...accepted];
    target.deletedMessageIds = compacted.deletedMessageIds;
    target.messages.sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
  }
  for (const conflict of conflicts) onConflict(conflict.id);
  return before !== JSON.stringify(target) + (overflow?.state() ?? '');
}
