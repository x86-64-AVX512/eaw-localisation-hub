export interface ReviewPresence {
  clientId: string;
  user: string;
  positionByte: number;
  anchorByte: number;
  color: string;
  avatarBase64?: string;
}

export interface ReviewReservationTarget {
  id: string;
  displayName: string;
  isSelf?: boolean;
  color: string;
  avatarBase64?: string;
}

export interface ReviewReservation {
  id: string;
  startByte: number;
  endByte: number;
  keyCount: number;
  status: string;
  createdBy?: string;
  assignee: string;
  assigneeId: string;
  comment?: string;
  color: string;
}

export interface ReviewExternalConflict {
  key: string;
  label: string;
  detail?: string;
  source?: string;
  collaborativeLine?: string;
  externalLine?: string;
  [key: string]: unknown;
}

export interface ReviewCollaborationState {
  path: string;
  user: string;
  color: string;
  avatarBase64: string;
  presences: Map<string, ReviewPresence>;
  reservations: Map<string, ReviewReservation>;
  reservationTargets: ReviewReservationTarget[];
  externalConflicts: Map<string, ReviewExternalConflict>;
  selectedReservation: string;
  selectedConflict: string;
}

export type CollaborationCommand =
  | { type: 'reservationCreate'; path: string; startByte: number; endByte: number;
      assigneeId: string; assignee: string; assigneeColor: string; comment: string }
  | { type: 'reservationDeleteAt'; path: string; positionByte: number }
  | { type: 'reservationDelete'; path: string; id: string }
  | { type: 'externalConflictResolve'; path: string; key: string; source: string;
      choice: 'collaborative' | 'external' };

export interface CollaborationPanelOptions {
  state: ReviewCollaborationState;
  editor: Monaco.editor.IStandaloneCodeEditor;
  send: (message: CollaborationCommand) => void;
  selectionBytes: () => { start: number; end: number };
  jumpToBytes: (start: number, end: number) => void;
  showToast: (message: string, isError?: boolean) => void;
  openConflictDiff?: (conflict: ReviewExternalConflict) => void;
}
import type * as Monaco from 'monaco-editor';
