import type { ReviewComment, ReviewSuggestion } from './review-card-types.ts';
import type { ReviewCardMessage } from './review-card-elements.ts';
import type { ReviewPresence, ReviewReservation, ReviewReservationTarget, ReviewExternalConflict } from './review-state.ts';
import type { ActiveProjection } from './editing-mode.ts';
import type { DocumentVariants } from './document-variants-types.ts';
import type { HistoryEntry } from './history-panel.ts';
import type { Ticket } from './ticket-panel.ts';
import type { createReviewDocument } from './review-document.ts';

export interface BootstrapPayload {
  path: string;
  relativePath: string;
  workspace: string;
  ticket: Ticket | null;
  user: string;
  color: string;
  textBase64: string;
  readOnly?: boolean;
  error?: string;
}


export function createAppState() {
  return {
    path: '', relativePath: '', workspace: '', ticket: null as Ticket | null,
    user: '', userId: '', color: '#6aa9ff', avatarBase64: '', ready: false, applyingRemote: false,
    suggestions: new Map<string, ReviewSuggestion>(), comments: new Map<string, ReviewComment>(),
    presences: new Map<string, ReviewPresence>(), reservations: new Map<string, ReviewReservation>(),
    reservationTargets: [] as ReviewReservationTarget[], externalConflicts: new Map<string, ReviewExternalConflict>(),
    selectedReservation: '', selectedConflict: '',
    suggestionMessages: new Map<string, ReviewCardMessage[]>(), commentMessages: new Map<string, ReviewCardMessage[]>(),
    recoveryStatus: '', temporaryPassword: false,
    history: [] as HistoryEntry[], historyHeadId: '', editingSuggestionId: '',
    suggestionProjection: null as ActiveProjection | null,
    documentView: 'shared', documentVariants: null as DocumentVariants | null,
    reviewDocument: null as ReturnType<typeof createReviewDocument> | null,
    version: '', serverVersion: '', trainingProgress: {} as Record<string, number>, trainingProgressConfirmed: false,
  };
}
