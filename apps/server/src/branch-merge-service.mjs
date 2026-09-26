import { mergeLocalisationThreeWay } from '../../../packages/shared/src/merge.mts';
import { captureReviewAnchor, repairReviewAnchors } from './review-anchors.mjs';

const TARGET_BRANCH = 'general-dev';
const MAX_COMMENTS_PER_ROOM = 500;
const PROTECTED_BRANCHES = new Set(['general-dev', 'master', 'main']);

function hasUnmergedWork(source, targetGitText) {
  const base = source.gitBase?.text;
  if (typeof base !== 'string') return true;
  const shared = mergeLocalisationThreeWay(base, source.currentText(), targetGitText);
  if (shared.conflicts.length || shared.text !== targetGitText) return true;
  for (const [authorId, variant] of source.history.authorVariants) {
    if (!variant.size) continue;
    const personal = source.history.personalProjection(authorId, base);
    const result = mergeLocalisationThreeWay(base, personal, targetGitText);
    if (result.conflicts.length || result.text !== targetGitText) return true;
  }
  return false;
}

function copyComments(source, target) {
  const previous = target.commentThreads;
  const next = previous.map((thread) => structuredClone(thread));
  const existing = new Map(next.map((thread) => [thread.id, thread]));
  let changed = false;
  for (const thread of source.commentThreads) {
    const current = existing.get(thread.id);
    if (current) {
      current.messages ??= [];
      const messageIds = new Set((current.messages ?? []).map((message) => message.id));
      const missing = (thread.messages ?? []).filter((message) => !messageIds.has(message.id));
      if (current.messages.length + missing.length > 100) {
        throw new Error('Merged discussion exceeds the target message limit');
      }
      if (missing.length) {
        current.messages.push(...structuredClone(missing));
        current.messages.sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
        changed = true;
      }
      if (thread.status === 'resolved' && current.status !== 'resolved') {
        current.status = 'resolved';
        changed = true;
      }
      continue;
    }
    captureReviewAnchor(source.document, thread);
    const copy = structuredClone(thread);
    repairReviewAnchors(target.document, [copy], { force: true });
    next.push(copy);
    existing.set(copy.id, copy);
    changed = true;
  }
  if (!changed) return false;
  if (next.length > MAX_COMMENTS_PER_ROOM) {
    throw new Error('Merged comments exceed the target room limit');
  }
  target.commentThreads = next;
  try {
    target.assertMetadataBudget();
  } catch (error) {
    target.commentThreads = previous;
    throw error;
  }
  target.schedulePersist();
  target.broadcastReview();
  return true;
}

export class BranchMergeService {
  constructor(canonicalSource, roomRegistry, ticketStore, targetBranch = TARGET_BRANCH) {
    this.canonicalSource = canonicalSource;
    this.roomRegistry = roomRegistry;
    this.ticketStore = ticketStore;
    this.targetBranch = targetBranch;
    this.pending = null;
  }

  candidates() {
    const branches = new Set(this.roomRegistry.branchHints.keys());
    for (const ticket of this.ticketStore.list({ archived: true })) branches.add(ticket.baseBranch);
    return [...branches].filter((branch) => branch && branch !== this.targetBranch
      && !PROTECTED_BRANCHES.has(branch) && !branch.startsWith('ticket-')
      && !this.roomRegistry.mergedBranches.has(branch));
  }

  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.refreshExclusive().finally(() => { this.pending = null; });
    return this.pending;
  }

  async refreshExclusive() {
    if (!this.canonicalSource?.enabled) return;
    const target = await this.canonicalSource.head(this.targetBranch);
    if (!target || target.stale) return;
    for (const branch of this.candidates()) {
      try {
        let source;
        try { source = await this.canonicalSource.head(branch, { force: true }); } catch { /* deleted branch */ }
        const hint = this.roomRegistry.branchHints.get(branch);
        const commit = source?.commit ?? hint?.commit
          ?? this.ticketStore.list({ archived: true }).find((ticket) => ticket.baseBranch === branch)?.baseCommit;
        if (!commit) continue;
        const sourceDeleted = source?.deleted === true || (!source
          && await this.canonicalSource.branchDeleted(branch));
        const merged = await this.canonicalSource.mergedInto(
          branch, this.targetBranch, commit, target.commit,
          { sourceStale: !source || source.stale, sourceDeleted },
        );
        if (merged) await this.migrate(branch, target.commit, commit);
      } catch (error) {
        console.error(`[server] branch merge migration failed for ${branch}: ${error.message}`);
      }
    }
  }

  async migrate(branch, targetCommit, sourceCommit = '') {
    const files = await this.canonicalSource.listFiles(this.targetBranch);
    const available = new Set(files);
    const sourceIds = this.roomRegistry.documentIdsForBranch(branch, files);
    const unidentified = this.roomRegistry.unresolvedLegacyHashes(branch, files);
    if (unidentified.length) throw new Error(`${unidentified.length} legacy document(s) cannot be mapped safely`);
    const unavailable = sourceIds.filter((id) => !available.has(id.slice(branch.length + 1)));
    if (unavailable.length) throw new Error(`${unavailable.length} source document(s) have no target file`);
    const affectedTickets = this.ticketStore.list({ archived: true })
      .filter((ticket) => ticket.baseBranch === branch);
    const missingTickets = affectedTickets.filter((ticket) => ticket.files.some((file) => !available.has(file)));
    if (missingTickets.length) throw new Error(`${missingTickets.length} ticket(s) have no target file`);

    this.roomRegistry.mergingBranches.add(branch);
    try {
      const roomPairs = [];
      for (const sourceId of sourceIds) {
        const relativePath = sourceId.slice(branch.length + 1);
        const source = await this.roomRegistry.get(sourceId);
        const target = await this.roomRegistry.get(`${this.targetBranch}:${relativePath}`);
        roomPairs.push({ relativePath, source, target });
      }
      for (const { relativePath, source, target } of roomPairs) {
        await this.roomRegistry.withRoomsLocked([source, target], async () => {
          if (hasUnmergedWork(source, target.gitBase?.text ?? target.currentText())) {
            throw new Error(`Unmerged personal or shared text remains in ${relativePath}`);
          }
          if (target.gitBase?.commit && target.gitBase.commit !== targetCommit) {
            throw new Error('general-dev changed during merge migration');
          }
        });
      }
      for (const { source, target } of roomPairs) {
        await this.roomRegistry.withRoomsLocked([source, target], async () => {
          copyComments(source, target);
        });
        await target.flush();
      }
      const currentTarget = await this.canonicalSource.head(this.targetBranch);
      if (!currentTarget || currentTarget.stale || currentTarget.commit !== targetCommit) {
        throw new Error('general-dev changed during merge migration');
      }
      if (sourceCommit) {
        const currentSource = await this.canonicalSource.head(branch, { force: true }).catch(() => null);
        if (currentSource && !currentSource.stale && currentSource.commit !== sourceCommit) {
          throw new Error('Source branch advanced during merge migration');
        }
      }
      await this.ticketStore.retargetMergedBranch(branch, this.targetBranch, targetCommit, files);
      await this.roomRegistry.markBranchMerged(branch, this.targetBranch, targetCommit, sourceIds);
      await this.roomRegistry.deleteDocuments(sourceIds, `Branch merged into ${this.targetBranch}`);
      console.log(`[server] migrated merged branch ${branch} to ${this.targetBranch}`);
    } finally {
      this.roomRegistry.mergingBranches.delete(branch);
    }
  }
}
