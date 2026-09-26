import type * as Monaco from 'monaco-editor';

export interface MinePatch {
  positionByte: number;
  deleteBytes: number;
  insertBase64: string;
}

export interface LocalSelection {
  id: string;
  kind: string;
  state: 'included' | 'excluded' | 'custom';
  label: string;
  lineNumber: number;
  gitLine: string | null;
  sharedLine: string | null;
}

export interface PersonalGitConflict {
  id: string;
  key: string;
  label: string;
  reason?: string;
  baseLine?: string | null;
  collaborativeLine?: string | null;
  externalLine?: string | null;
}

export interface DocumentVariantsPayload {
  sharedBase64?: string;
  mineBase64?: string;
  gitBase64?: string;
  minePatch?: MinePatch;
  mineBaseRevision?: string;
  mineRevision?: string;
  contributors?: { id: string; displayName: string }[];
  conflicts?: unknown[];
  gitConflicts?: PersonalGitConflict[];
  localSelections?: LocalSelection[];
  localSelectionBlocked?: string;
  localSelectionRevision?: string;
}

export interface VariantTexts {
  shared: string;
  mine: string;
  git: string;
  mineRevision: string;
  minePatchMissed: boolean;
}

export interface DocumentVariants extends VariantTexts {
  authors: Map<string, string>;
  contributors: { id: string; displayName: string }[];
  conflicts: unknown[];
  gitConflicts: PersonalGitConflict[];
  localSelections: LocalSelection[];
  localSelectionBlocked: string;
  localSelectionRevision: string;
}

export interface DocumentVariantsState {
  ready: boolean;
  documentView: string;
  path: string;
  documentVariants: DocumentVariants | null;
  reviewDocument?: { text(): string | null } | null;
  applyingRemote: boolean;
  ticket?: { status?: string } | null;
}

export type DocumentVariantsCommand =
  | { type: 'personalFileSelectionSet'; path: string; changeId: string; include: 0 | 1; revision: string }
  | { type: 'personalConflictResolve'; path: string; key: string; choice: 'mine' | 'git'; conflictId: string }
  | { type: 'documentVariantRequest'; path: string; authorId: string; variantEpoch: string }
  | { type: 'personalFileMaterialize'; path: string; mode: 'git' | 'mine' }
  | { type: 'documentVariantsRequest'; path: string };

export interface DocumentVariantsOptions {
  monaco: typeof Monaco;
  state: DocumentVariantsState;
  editor: Monaco.editor.IStandaloneCodeEditor;
  send: (message: DocumentVariantsCommand) => void;
  showToast: (message: string, isError?: boolean) => void;
  beforeChange(): void;
  afterChange(): void;
  onChanged(): void;
}
