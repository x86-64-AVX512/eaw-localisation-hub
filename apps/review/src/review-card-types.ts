import type * as Monaco from 'monaco-editor';
import type { ReviewCardItem, ReviewCardMessage } from './review-card-elements.ts';

export interface ReviewItemBase extends Omit<ReviewCardItem, 'kind'> {
  startByte: number;
  endByte: number;
}

export interface ReviewComment extends ReviewItemBase {
  summaryBase64: string;
}

export interface ReviewSuggestion extends ReviewItemBase {
  authorId?: string;
  originalBase64: string;
  replacementBase64: string;
  traceJson?: string;
}

export type CardItem = (ReviewComment & { kind: 'comment' }) | (ReviewSuggestion & { kind: 'suggestion' });

export interface ReviewCardsState {
  path: string;
  user: string;
  userId: string;
  editingSuggestionId: string;
  comments: Map<string, ReviewComment>;
  suggestions: Map<string, ReviewSuggestion>;
  commentMessages: Map<string, ReviewCardMessage[]>;
  suggestionMessages: Map<string, ReviewCardMessage[]>;
}

export interface ReviewCardsOptions {
  state: ReviewCardsState;
  editor: Monaco.editor.IStandaloneCodeEditor;
  rangeFromBytes: (startByte: number, endByte: number) => Monaco.Range;
  send: (message: { type: string; path: string; id: string; bodyBase64?: string; status?: string }) => void;
  askText: (title: string, placeholder: string) => Promise<string | null | undefined>;
  onEditSuggestion?: (item: ReviewSuggestion & { kind: 'suggestion' }) => unknown;
  onAcceptSuggestion?: (item: ReviewSuggestion & { kind: 'suggestion' }) => void;
  onRevertSuggestion?: (item: ReviewSuggestion & { kind: 'suggestion' }) => void;
}
