import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TRACKED_PATH_PATTERN } from '../../../packages/shared/src/constants.mts';
import { resolveReviewRange } from './review-anchors.mjs';

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0; let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function discussionSummary(document, item, starts) {
  const range = resolveReviewRange(document, item);
  const line = range && !item.orphaned ? lineAt(starts, range.start) : null;
  return {
    id: item.id,
    author: item.author,
    status: item.status,
    line,
    orphaned: Boolean(item.orphaned || !range),
    originalText: item.originalText ?? '',
    replacementText: item.replacementText ?? '',
    messages: (item.messages ?? []).map((message) => ({
      id: message.id, author: message.author, body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

export class DeletedBranchArchive {
  constructor(canonicalSource, roomRegistry, ticketStore) {
    this.canonicalSource = canonicalSource;
    this.roomRegistry = roomRegistry;
    this.ticketStore = ticketStore;
  }

  async isDeleted(branch) {
    if (!this.canonicalSource?.enabled
      || this.roomRegistry.mergedBranches.has(branch)
      || !this.roomRegistry.branchHints.has(branch)) return false;
    return this.canonicalSource.branchDeleted(branch);
  }

  async list() {
    // Refresh refs once per menu opening; individual branch probes then reuse the result.
    await this.canonicalSource.remoteBranchNames?.({ force: true });
    const branches = [...this.roomRegistry.branchHints.keys()]
      .filter((branch) => !this.roomRegistry.mergedBranches.has(branch));
    const results = [];
    // Bound the GitHub requests and avoid loading any document merely to draw the menu.
    for (const branch of branches) {
      const fileIds = this.roomRegistry.documentIdsForBranch(branch)
        .filter((id) => this.roomRegistry.persisted.has(
          crypto.createHash('sha256').update(id).digest('hex')));
      const unknownCount = this.roomRegistry.unresolvedLegacyHashes(branch, []).length;
      if (!fileIds.length && !unknownCount) continue;
      if (!await this.isDeleted(branch)) continue;
      const tickets = this.ticketStore.list({ archived: true })
        .filter((ticket) => ticket.baseBranch === branch).length;
      results.push({
        branch,
        commit: this.roomRegistry.branchHints.get(branch)?.commit ?? '',
        files: fileIds.map((id) => id.slice(branch.length + 1)).sort(),
        unknownCount,
        tickets,
      });
    }
    return { branches: results };
  }

  async document(branch, relativePath) {
    if (!TRACKED_PATH_PATTERN.test(relativePath) || !await this.isDeleted(branch)) return null;
    const documentId = `${branch}:${relativePath}`;
    const hash = crypto.createHash('sha256').update(documentId).digest('hex');
    if (!this.roomRegistry.persisted.has(hash)) return null;
    if (this.roomRegistry.dataDirectory) {
      const directory = path.join(this.roomRegistry.dataDirectory, 'documents');
      try {
        await fs.access(path.join(directory, `${hash}.update`));
        const metadata = JSON.parse(await fs.readFile(path.join(directory, `${hash}.json`), 'utf8'));
        if (metadata.gitBase?.branch !== branch) return null;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }
    const room = await this.roomRegistry.get(documentId);
    if (room.gitBase?.branch !== branch) return null;
    const text = room.currentText();
    const starts = lineStarts(text);
    return {
      branch, relativePath,
      commit: room.gitBase.commit,
      textBase64: Buffer.from(text, 'utf8').toString('base64'),
      comments: room.commentThreads.map((thread) => discussionSummary(room.document, thread, starts)),
      suggestions: room.suggestions.map((suggestion) => discussionSummary(room.document, suggestion, starts)),
    };
  }
}
