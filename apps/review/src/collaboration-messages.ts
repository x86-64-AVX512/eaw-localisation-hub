import type { AgentMessage } from './agent-message.ts';
import type { createAppState } from './app-state.ts';
import type { ReservationUpdateResult } from './review-state.ts';
import { resetExternalConflicts, storeExternalConflict } from './git-conflict-state.ts';

type AppState = ReturnType<typeof createAppState>;

// Applies presence, reservation, conflict and discussion snapshots to Review
// state. Rendering is scheduled by the caller; returns false for other messages.
export function applyCollaborationMessage(state: AppState, message: AgentMessage,
  onReservationUpdate: (result: ReservationUpdateResult) => void): boolean {
  switch (message.type) {
    case 'presenceReset': state.presences.clear(); return true;
    case 'presence': state.presences.set(message.clientId, message); return true;
    case 'presenceSnapshot':
      state.presences = new Map((message.presences ?? []).map((item) => [item.clientId, item]));
      return true;
    case 'reservationReset': state.reservations.clear(); return true;
    case 'reservation': state.reservations.set(message.id, message); return true;
    case 'reservationSnapshot':
      state.reservationUpdates = message.canUpdate === true;
      state.reservations = new Map((message.reservations ?? []).map((item) => [item.id, item]));
      return true;
    case 'reservationUpdateResult': onReservationUpdate(message); return true;
    case 'reservationTargetReset': state.reservationTargets = []; return true;
    case 'reservationTarget': state.reservationTargets.push(message); return true;
    case 'reservationTargetSnapshot': state.reservationTargets = message.targets ?? []; return true;
    case 'externalConflictReset': resetExternalConflicts(state, message.source); return true;
    case 'externalConflict': storeExternalConflict(state, message); return true;
    case 'commentReset':
      state.comments.clear();
      state.commentMessages.clear();
      return true;
    case 'commentThread': state.comments.set(message.id, message); return true;
    case 'commentMessage': {
      const messages = state.commentMessages.get(message.id) ?? [];
      messages.push(message);
      state.commentMessages.set(message.id, messages);
      return true;
    }
    case 'suggestionReset':
      state.suggestions.clear();
      state.suggestionMessages.clear();
      return true;
    case 'suggestion': state.suggestions.set(message.id, message); return true;
    case 'suggestionMessage': {
      const messages = state.suggestionMessages.get(message.id) ?? [];
      messages.push(message);
      state.suggestionMessages.set(message.id, messages);
      return true;
    }
    default: return false;
  }
}
