export interface DiscussionDraft {
  key: string; kind: 'new' | 'reply' | 'edit'; target: 'comment' | 'suggestion';
  id: string; messageId: string; body: string; expectedRevision: number;
  startByte: number; endByte: number; reviewAnchors?: string;
  requestId?: string; submittedBody?: string;
}
export const DRAFT_PREFIX = 'eaw.discussion.drafts.v1:';
export function discussionDraftScope(state: { draftScope?: string; workspace?: string; relativePath?: string;
  path: string; userId?: string; user?: string; ticket?: {id:string} | null }): string {
  if (!state.path || !state.draftScope || !(state.userId || state.user)) return '';
  return DRAFT_PREFIX + JSON.stringify([state.draftScope, state.workspace, state.relativePath || state.path,
    state.ticket?.id ?? '', state.userId || state.user]);
}
export function loadDiscussionDrafts(storage: Pick<Storage,'getItem'>, scope: string): DiscussionDraft[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(scope) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is DiscussionDraft => item && typeof item === 'object'
      && ['new','reply','edit'].includes(item.kind) && ['comment','suggestion'].includes(item.target)
      && ['key','id','messageId','body'].every(field => typeof item[field] === 'string')
      && item.key.length <= 256 && item.id.length <= 128 && item.messageId.length <= 128
      && item.body.length <= 8192 && Number.isSafeInteger(item.expectedRevision) && item.expectedRevision >= 0
      && Number.isSafeInteger(item.startByte) && item.startByte >= 0 && Number.isSafeInteger(item.endByte) && item.endByte >= 0
      && (item.reviewAnchors === undefined || (typeof item.reviewAnchors === 'string' && item.reviewAnchors.length <= 32768))
      && (item.requestId === undefined || (typeof item.requestId === 'string' && item.requestId.length <= 128))
      && (item.submittedBody === undefined || (typeof item.submittedBody === 'string' && item.submittedBody.length <= 8192)))
      .slice(0, 32);
  } catch { return []; }
}
// A reply or new comment that the server already stored with older text continues
// as an edit of that stored message; resending it under its message id stays stale.
export function resumeDraftAsEdit(draft: DiscussionDraft, result: { status: string; revision?: number }): boolean {
  if (result.status !== 'saved' && !(result.status === 'stale' && draft.kind !== 'edit')) return false;
  draft.kind = 'edit'; draft.expectedRevision = result.revision ?? 0;
  delete draft.requestId; delete draft.submittedBody;
  return true;
}
export function saveDiscussionDrafts(storage: Pick<Storage,'setItem'|'removeItem'>, scope: string, drafts: DiscussionDraft[]): void {
  if (!scope) return;
  if (drafts.length) storage.setItem(scope, JSON.stringify(drafts)); else storage.removeItem(scope);
}
