import type * as Monaco from 'monaco-editor';
import { aiSentencesInRange, MAX_AI_REQUEST_CHARS } from '../../../packages/shared/src/ai-localisation.mts';
import type { ProofreadingLanguage } from '../../../packages/shared/src/ai-localisation.mts';
import { scanLocalisationEntries } from '../../../packages/shared/src/localisation-replace.mts';

export interface ProofreadingCandidate {
  key: string;
  text: string;
  line: number;
  startColumn: number;
  offset: number;
}

export function proofreadingCandidates(model: Monaco.editor.ITextModel, start: number, end: number,
  language: ProofreadingLanguage, atCursor = false) {
  const first = model.getPositionAt(start);
  const last = model.getPositionAt(end);
  const candidates: ProofreadingCandidate[] = [];
  for (let line = first.lineNumber; line <= last.lineNumber; line += 1) {
    if (line !== first.lineNumber && line === last.lineNumber && last.column === 1) break;
    const entry = scanLocalisationEntries(model.getLineContent(line)).entries[0];
    if (!entry) continue;
    const from = line === first.lineNumber ? first.column - 1 : 0;
    const to = line === last.lineNumber ? last.column - 1 : entry.end;
    if (!atCursor && (to < entry.start || from > entry.end)) continue;
    const offset = (column: number) => Math.max(0, Math.min(column, entry.end) - entry.start);
    const sentences = aiSentencesInRange(entry.text, offset(from), offset(to), language);
    for (const sentence of atCursor ? sentences.slice(-1) : sentences) {
      if (sentence.text.length + 12 > MAX_AI_REQUEST_CHARS) continue;
      const startColumn = entry.start + sentence.start + 1;
      candidates.push({ key: entry.key, text: sentence.text, line, startColumn,
        offset: model.getOffsetAt({ lineNumber: line, column: startColumn }) });
    }
  }
  return candidates;
}

export function updateProofreadingQueue(model: Monaco.editor.ITextModel, queued: ProofreadingCandidate[],
  changes: readonly Monaco.editor.IModelContentChange[], includeEdits: boolean, language: ProofreadingLanguage) {
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
  const updated = new Map<number, ProofreadingCandidate>();
  let delta = 0;
  let index = 0;
  for (const candidate of [...queued].sort((a, b) => a.offset - b.offset)) {
    while (index < sorted.length && sorted[index].rangeOffset + sorted[index].rangeLength <= candidate.offset) {
      const change = sorted[index++];
      delta += change.text.length - change.rangeLength;
    }
    const offset = candidate.offset + delta;
    const next = sorted[index];
    if (next && next.rangeOffset < candidate.offset + candidate.text.length) continue;
    const current = proofreadingCandidates(model, offset, offset + candidate.text.length, language)
      .find(item => item.offset === offset && item.text === candidate.text && item.key === candidate.key);
    if (current) updated.set(offset, Object.assign(candidate, current));
  }
  if (includeEdits) {
    delta = 0;
    for (const change of sorted) {
      const start = change.rangeOffset + delta;
      for (const candidate of proofreadingCandidates(model, start, start + change.text.length, language)) {
        if (!updated.has(candidate.offset)) updated.set(candidate.offset, candidate);
      }
      delta += change.text.length - change.rangeLength;
    }
  }
  return [...updated.values()].sort((a, b) => a.offset - b.offset);
}
