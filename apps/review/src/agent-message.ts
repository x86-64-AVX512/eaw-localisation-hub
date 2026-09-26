import type { DocumentVariantsPayload } from './document-variants-types.ts';
import type { HistoryEntry } from './history-panel.ts';
import type { ReviewCardMessage } from './review-card-elements.ts';
import type { ReviewComment, ReviewSuggestion } from './review-card-types.ts';
import type { ReviewDocumentUpdate } from './review-document.ts';
import type { ReviewExternalConflict, ReviewPresence, ReviewReservation, ReviewReservationTarget } from './review-state.ts';

type AgentMessageBody =
  | { type: 'ticketCatalogChanged'; revision?: string }
  | { type: 'ticketUnavailable'; ticketId: string; reason?: string }
  | { type: 'agentHello'; user: string; userId?: string; color?: string; avatarBase64?: string;
      recoveryStatus?: string; temporaryPassword?: boolean; workspace: string; version?: string;
      serverVersion?: string; trainingProgress?: Record<string, number>; trainingProgressConfirmed?: boolean }
  | { type: 'documentStatus'; status: string; reason?: string; branch?: string; changedFiles?: string[]; message?: string }
  | { type: 'documentReady' }
  | ({ type: 'documentSync' } & ReviewDocumentUpdate)
  | { type: 'replace'; positionByte: number; deleteBytes: number; insertBase64: string }
  | ({ type: 'documentVariants' } & DocumentVariantsPayload)
  | { type: 'documentVariant'; variantEpoch: string; authorId: string; textBase64: string }
  | { type: 'personalFileStatus'; message: string }
  | { type: 'reviewBatchStart' | 'reviewBatchEnd' | 'presenceReset' | 'reservationReset'
      | 'reservationTargetReset' | 'commentReset' | 'suggestionReset' }
  | ({ type: 'presence' } & ReviewPresence)
  | { type: 'presenceSnapshot'; presences?: ReviewPresence[] }
  | ({ type: 'reservation' } & ReviewReservation)
  | { type: 'reservationSnapshot'; reservations?: ReviewReservation[] }
  | ({ type: 'reservationTarget' } & ReviewReservationTarget)
  | { type: 'reservationTargetSnapshot'; targets?: ReviewReservationTarget[] }
  | { type: 'externalConflictReset'; source?: string }
  | ({ type: 'externalConflict' } & ReviewExternalConflict)
  | ({ type: 'commentThread' } & ReviewComment)
  | ({ type: 'commentMessage' } & ReviewCardMessage & { id: string })
  | ({ type: 'suggestion' } & ReviewSuggestion)
  | ({ type: 'suggestionMessage' } & ReviewCardMessage & { id: string })
  | { type: 'notice' | 'error'; message: string }
  | { type: 'history'; entries?: HistoryEntry[]; headId?: string }
  | { type: 'historyVersion'; id: string; textBase64: string }
  | { type: 'recoveryCode'; recoveryCode: string }
  | { type: 'workspaceChanged'; workspace?: string; phase: string; message: string };

export type AgentMessage = AgentMessageBody & { path?: string };

type FieldKind = 'string' | 'number' | 'boolean' | 'array';
type Shape = Readonly<Record<string, FieldKind>>;

const requiredFields: Readonly<Record<AgentMessage['type'], Shape>> = {
  ticketCatalogChanged: {}, ticketUnavailable: { ticketId: 'string' },
  agentHello: { user: 'string', workspace: 'string' },
  documentStatus: { status: 'string' }, documentReady: {},
  documentSync: { documentId: 'string', path: 'string', updateBase64: 'string' },
  replace: { positionByte: 'number', deleteBytes: 'number', insertBase64: 'string' },
  documentVariants: {}, documentVariant: { variantEpoch: 'string', authorId: 'string', textBase64: 'string' },
  personalFileStatus: { message: 'string' },
  reviewBatchStart: {}, reviewBatchEnd: {}, presenceReset: {},
  presence: { clientId: 'string', user: 'string', positionByte: 'number', anchorByte: 'number', color: 'string' },
  presenceSnapshot: {}, reservationReset: {},
  reservation: { id: 'string', startByte: 'number', endByte: 'number', keyCount: 'number', status: 'string', assignee: 'string', assigneeId: 'string', color: 'string' },
  reservationSnapshot: {}, reservationTargetReset: {},
  reservationTarget: { id: 'string', displayName: 'string', color: 'string' },
  reservationTargetSnapshot: {}, externalConflictReset: {}, externalConflict: { key: 'string', label: 'string' },
  commentReset: {}, commentThread: { id: 'string', status: 'string', startByte: 'number', endByte: 'number', summaryBase64: 'string' },
  commentMessage: { id: 'string' }, suggestionReset: {},
  suggestion: { id: 'string', status: 'string', startByte: 'number', endByte: 'number', originalBase64: 'string', replacementBase64: 'string' },
  suggestionMessage: { id: 'string' }, notice: { message: 'string' }, error: { message: 'string' },
  history: {}, historyVersion: { id: 'string', textBase64: 'string' }, recoveryCode: { recoveryCode: 'string' },
  workspaceChanged: { phase: 'string', message: 'string' },
};

const optionalFields: Partial<Readonly<Record<AgentMessage['type'], Shape>>> = {
  ticketCatalogChanged: { revision: 'string' }, ticketUnavailable: { reason: 'string' },
  agentHello: { userId: 'string', color: 'string', avatarBase64: 'string', recoveryStatus: 'string',
    temporaryPassword: 'boolean', version: 'string', serverVersion: 'string', trainingProgressConfirmed: 'boolean' },
  documentStatus: { reason: 'string', branch: 'string', changedFiles: 'array', message: 'string' },
  documentVariants: { sharedBase64: 'string', mineBase64: 'string', gitBase64: 'string',
    mineBaseRevision: 'string', mineRevision: 'string', contributors: 'array', conflicts: 'array',
    gitConflicts: 'array', localSelections: 'array', localSelectionBlocked: 'string', localSelectionRevision: 'string' },
  presenceSnapshot: { presences: 'array' }, reservationSnapshot: { reservations: 'array' },
  reservationTargetSnapshot: { targets: 'array' }, externalConflictReset: { source: 'string' },
  history: { entries: 'array', headId: 'string' }, workspaceChanged: { workspace: 'string' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fieldsMatch(value: Record<string, unknown>, fields: Shape): boolean {
  return Object.entries(fields).every(([field, kind]) =>
    kind === 'array' ? Array.isArray(value[field]) : typeof value[field] === kind);
}

function optionalFieldsMatch(value: Record<string, unknown>, fields: Shape): boolean {
  return Object.entries(fields).every(([field, kind]) => value[field] === undefined
    || (kind === 'array' ? Array.isArray(value[field]) : typeof value[field] === kind));
}

function optionalArray(value: Record<string, unknown>, field: string, fields: Shape): boolean {
  const items = value[field];
  return items === undefined || (Array.isArray(items) && items.every((item) => isRecord(item) && fieldsMatch(item, fields)));
}

// The socket is a trust boundary: narrow the JSON envelope before it enters
// the typed Review state. Unknown message types remain ignorable for compatibility.
export function parseAgentMessage(value: unknown): AgentMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const shape = requiredFields[value.type as AgentMessage['type']];
  if (!shape || (value.path !== undefined && typeof value.path !== 'string') || !fieldsMatch(value, shape)
    || !optionalFieldsMatch(value, optionalFields[value.type as AgentMessage['type']] ?? {})) return null;
  if (value.type === 'agentHello' && value.trainingProgress !== undefined
    && (!isRecord(value.trainingProgress) || !Object.values(value.trainingProgress).every((revision) => typeof revision === 'number'))) return null;
  if (value.type === 'documentStatus' && value.changedFiles !== undefined
    && !(value.changedFiles as unknown[]).every((file) => typeof file === 'string')) return null;
  if (value.type === 'presenceSnapshot' && !optionalArray(value, 'presences', requiredFields.presence)) return null;
  if (value.type === 'reservationSnapshot' && !optionalArray(value, 'reservations', requiredFields.reservation)) return null;
  if (value.type === 'reservationTargetSnapshot' && !optionalArray(value, 'targets', requiredFields.reservationTarget)) return null;
  if (value.type === 'history' && !optionalArray(value, 'entries', {
    id: 'string', reason: 'string', author: 'string', createdAt: 'string',
  })) return null;
  if (value.type === 'documentVariants' && value.minePatch !== undefined
    && (!isRecord(value.minePatch) || !fieldsMatch(value.minePatch, {
      positionByte: 'number', deleteBytes: 'number', insertBase64: 'string',
    }))) return null;
  return value as AgentMessage;
}
