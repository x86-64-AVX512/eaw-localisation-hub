import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { colorClass, decodeBase64, safeColor } from './review-utilities.ts';
import { createPresenceCursorLayer } from './presence-cursors.ts';
import { activeSuggestionPreview, suggestionPreview } from './suggestion-preview.ts';
import { suggestionTraceParts } from '../../../packages/shared/src/suggestion-trace.mts';
import type * as Monaco from 'monaco-editor';
import type { ReviewComment, ReviewSuggestion } from './review-card-types.ts';
import type { ReviewPresence, ReviewReservation } from './review-state.ts';

interface ActiveProjection {
  baseText: string;
  start: number;
  previousEnd: number;
  replacementLength: number;
  traceJson?: string;
  color: string;
  author: string;
}

interface DecorationState {
  suggestionProjection: ActiveProjection | null;
  editingSuggestionId: string;
  suggestions: Map<string, ReviewSuggestion>;
  comments: Map<string, ReviewComment>;
  presences: Map<string, ReviewPresence>;
  reservations: Map<string, ReviewReservation>;
}

interface DecorationOptions {
  monaco: typeof Monaco;
  state: DecorationState;
  editor: Monaco.editor.IStandaloneCodeEditor;
  rangeFromBytes: (startByte: number, endByte: number) => Monaco.Range;
  onLayout: () => void;
}

export function completedSuggestionZoneAfterLine(range: Monaco.Range): number {
  const start = range.getStartPosition();
  const end = range.getEndPosition();
  return Math.max(start.lineNumber, end.lineNumber);
}

export function createDecorationRenderer({ monaco, state, editor, rangeFromBytes, onLayout }: DecorationOptions) {
  const collection = editor.createDecorationsCollection();
  const cursors = createPresenceCursorLayer({ monaco, editor });
  let activeZoneId: string | undefined;
  let activeZoneKey = '';
  let completedZoneIds: string[] = [];
  let completedZoneKey = '';
  let refreshFrame = 0;
  let disposed = false;
  const metricsKey = () => {
    const font = editor.getOption(monaco.editor.EditorOption.fontInfo);
    const layout = editor.getLayoutInfo();
    return JSON.stringify([layout.contentWidth, layout.verticalScrollbarWidth, font.fontFamily,
      font.fontSize, font.fontWeight, font.lineHeight, font.letterSpacing]);
  };
  const schedule = () => {
    cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(() => { if (!disposed) refreshDecorations(); });
  };
  const layoutSubscription = editor.onDidLayoutChange(schedule);
  const fontSubscription = editor.onDidChangeConfiguration(event => {
    if (event.hasChanged(monaco.editor.EditorOption.fontInfo)) schedule();
  });

  function textRuns(text: string): Array<{ offset: number; text: string }> {
    const runs: Array<{ offset: number; text: string }> = [];
    const expression = /[^\r\n]+/gu;
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      runs.push({ offset: match.index, text: match[0] });
    }
    return runs;
  }

  function syncActiveOriginalZone(projection: ActiveProjection | null): void {
    const original = projection ? projection.baseText.slice(projection.start, projection.previousEnd) : '';
    const multiline = original.includes('\n');
    const replacement = projection ? editor.getModel()?.getValue().slice(projection.start,
      projection.start + projection.replacementLength) ?? '' : '';
    const { zoneText } = activeSuggestionPreview(original, replacement);
    const nextKey = multiline && projection
      ? `${projection.start}:${projection.previousEnd}:${projection.color}:${zoneText}:${metricsKey()}`
      : '';
    if (nextKey === activeZoneKey) return;
    editor.changeViewZones((accessor) => {
      if (activeZoneId) accessor.removeZone(activeZoneId);
      activeZoneId = undefined;
      activeZoneKey = nextKey;
      if (!multiline) return;
      const model = editor.getModel();
      if (!model || !projection) return;
      const position = model.getPositionAt(projection.start);
      const lineStart = projection.baseText.lastIndexOf('\n', projection.start - 1) + 1;
      const prefix = projection.baseText.slice(lineStart, projection.start);
      const preview = suggestionPreview(monaco, editor, (prefix.trim() ? '' : prefix) + zoneText,
        'active-suggestion-original-zone', safeColor(projection.color));
      activeZoneId = accessor.addZone({
        afterLineNumber: Math.max(0, position.lineNumber - 1),
        ...preview,
      });
    });
  }

  function syncCompletedMultilineZones(items: Array<{ item: ReviewSuggestion; replacement: string }>,
    resolvedRange: (startByte: number, endByte: number) => Monaco.Range | null): void {
    const candidates = items.filter(({ item, replacement }) => item.id !== state.editingSuggestionId
      && item.status === 'open' && replacement.includes('\n'));
    const nextKey = candidates.map(({ item, replacement }) => [
      item.id, item.startByte, item.endByte, item.status, item.color, replacement,
    ].join(':')).join('|') + metricsKey();
    if (nextKey === completedZoneKey) return;
    editor.changeViewZones((accessor) => {
      for (const id of completedZoneIds) accessor.removeZone(id);
      completedZoneIds = [];
      completedZoneKey = nextKey;
      for (const { item, replacement } of candidates) {
        const range = resolvedRange(item.startByte, item.endByte);
        if (!range) continue;
        const preview = suggestionPreview(monaco, editor, replacement.replace(/\r\n|\r/gu, '\n').replace(/^\n|\n$/gu, ''),
          'multiline-suggestion-zone', safeColor(item.color));
        const { domNode } = preview;
        domNode.setAttribute('aria-label', uiText("Предлагаемый перенос строки"));
        completedZoneIds.push(accessor.addZone({
          // The proposed line belongs after the struck original. Placing a
          // leading-newline replacement before a column-one range reverses
          // the visual order (replacement above deletion).
          afterLineNumber: completedSuggestionZoneAfterLine(range),
          ...preview,
        }));
      }
    });
  }

  function refreshDecorations(): void {
    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    const resolvedRange = (start: number, end: number): Monaco.Range | null => {
      try { return rangeFromBytes(start, end); } catch { return null; }
    };
    const activeProjection = state.suggestionProjection;
    syncActiveOriginalZone(activeProjection);
    if (activeProjection) {
      const model = editor.getModel();
      if (!model) return;
      const color = safeColor(activeProjection.color);
      const strikeClass = colorClass('suggestion-strike', color,
        (value) => `color:${value};text-decoration:line-through;text-decoration-color:${value};text-decoration-thickness:2px`);
      const replacementClass = colorClass('suggestion-after', color,
        (value) => `color:${value};font-weight:650;text-decoration:none`);
      const original = activeProjection.baseText.slice(
        activeProjection.start, activeProjection.previousEnd,
      );
      const projectedText = model.getValue();
      const replacementEnd = activeProjection.start + activeProjection.replacementLength;
      const replacement = projectedText.slice(activeProjection.start, replacementEnd);
      let { inlineTail } = activeSuggestionPreview(original, replacement);
      if (inlineTail) {
        const lineStart = activeProjection.baseText.lastIndexOf('\n', activeProjection.start - 1) + 1;
        const prefix = activeProjection.baseText.slice(lineStart, activeProjection.start);
        if (!prefix.trim() && inlineTail.startsWith(prefix)) inlineTail = inlineTail.slice(prefix.length);
        decorations.push({ range: monaco.Range.fromPositions(model.getPositionAt(activeProjection.start)),
          options: { before: { content: inlineTail, inlineClassName: strikeClass }, showIfCollapsed: true } });
      }
      let replacementOffset = 0;
      for (const part of suggestionTraceParts(original, replacement, activeProjection.traceJson)) {
        if (part.kind === 'delete' && !part.text.includes('\n')) {
          const position = model.getPositionAt(activeProjection.start + replacementOffset);
          decorations.push({ range: monaco.Range.fromPositions(position), options: {
            before: { content: part.text, inlineClassName: strikeClass }, showIfCollapsed: true,
          } });
        } else if (part.kind === 'insert') {
          for (const run of textRuns(part.text)) {
            const start = model.getPositionAt(activeProjection.start + replacementOffset + run.offset);
            const end = model.getPositionAt(
              activeProjection.start + replacementOffset + run.offset + run.text.length,
            );
            decorations.push({ range: monaco.Range.fromPositions(start, end), options: {
              inlineClassName: replacementClass,
              hoverMessage: { value: uiText("**{0}** редактирует правку", activeProjection.author) },
            } });
          }
        }
        if (part.kind !== 'delete') replacementOffset += part.text.length;
      }
    }
    const suggestionItems = [...state.suggestions.values()].map((item) => ({
      item, replacement: decodeBase64(item.replacementBase64),
    }));
    syncCompletedMultilineZones(suggestionItems, resolvedRange);
    for (const presence of state.presences.values()) {
      if (presence.positionByte !== presence.anchorByte) {
        const selectionClass = colorClass('remote-selection', presence.color,
          (color) => `background:${color}45;border-bottom:1px solid ${color}`);
        const range = resolvedRange(Math.min(presence.positionByte, presence.anchorByte),
          Math.max(presence.positionByte, presence.anchorByte));
        if (range) decorations.push({
          range,
          options: { inlineClassName: selectionClass, hoverMessage: { value: presence.user } },
        });
      }
      const glyphClass = colorClass('remote-caret-glyph', presence.color, (color) => [
        `background:linear-gradient(${color},${color}) center/4px 17px no-repeat`,
        'border-radius:3px',
      ].join(';'));
      const caret = resolvedRange(presence.positionByte, presence.positionByte);
      if (caret) decorations.push({ range: caret, options: {
        glyphMarginClassName: glyphClass,
        glyphMarginHoverMessage: { value: presence.user },
        hoverMessage: { value: presence.user },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      } });
    }
    cursors.sync(state.presences.values(), (positionByte) =>
      resolvedRange(positionByte, positionByte)?.getStartPosition() ?? null);
    for (const item of state.reservations.values()) {
      if (item.status === 'orphaned' || item.startByte === item.endByte) continue;
      const reservationClass = colorClass('reservation-range', item.color,
        (color) => `background:${color}25;border-bottom:1px solid ${color}`);
      const delegated = item.createdBy && item.createdBy !== item.assignee ? uiText(" · создал: {0}", item.createdBy) : '';
      const range = resolvedRange(item.startByte, item.endByte);
      if (range) decorations.push({ range, options: {
        inlineClassName: reservationClass,
        hoverMessage: { value: uiText("**Бронь: {0}**{1}{2}", item.assignee, delegated, item.comment ? `  \n${item.comment}` : '') },
      } });
    }
    for (const item of state.comments.values()) {
      if (item.status !== 'open') continue;
      const range = resolvedRange(item.startByte, item.endByte);
      if (range) decorations.push({ range, options: {
        inlineClassName: 'comment-range', glyphMarginClassName: 'comment-glyph',
        glyphMarginHoverMessage: { value: `${item.author}: ${decodeBase64(item.summaryBase64)}` },
      } });
    }
    for (const { item, replacement: decodedReplacement } of suggestionItems) {
      if (item.id === state.editingSuggestionId) continue;
      if (item.status !== 'open') continue;
      const color = safeColor(item.color);
      const strikeClass = colorClass('suggestion-strike', color,
        (value) => `color:${value};text-decoration:line-through;text-decoration-color:${value};text-decoration-thickness:2px`);
      const afterClass = colorClass('suggestion-after', color,
        (value) => `color:${value};font-weight:650;text-decoration:none`);
      const original = decodeBase64(item.originalBase64);
      const replacement = decodedReplacement || uiText("[удалить]");
      const range = resolvedRange(item.startByte, item.endByte);
      if (range) {
        const model = editor.getModel();
        if (!model) continue;
        const rangeStart = model.getOffsetAt(range.getStartPosition());
        let originalOffset = 0;
        for (const part of suggestionTraceParts(original, decodedReplacement, item.traceJson)) {
          if (part.kind === 'delete') {
            for (const run of textRuns(part.text)) {
              const start = model.getPositionAt(rangeStart + originalOffset + run.offset);
              const end = model.getPositionAt(
                rangeStart + originalOffset + run.offset + run.text.length,
              );
              decorations.push({ range: monaco.Range.fromPositions(start, end), options: {
                inlineClassName: strikeClass, showIfCollapsed: true,
              } });
            }
            originalOffset += part.text.length;
          } else if (part.kind === 'equal') {
            originalOffset += part.text.length;
          } else if (!decodedReplacement.includes('\n')) {
            const position = model.getPositionAt(rangeStart + originalOffset);
            decorations.push({ range: monaco.Range.fromPositions(position), options: {
              after: { content: part.text, inlineClassName: afterClass }, showIfCollapsed: true,
              hoverMessage: { value: uiText("**{0}** предлагает: {1}", item.author, replacement) },
            } });
          }
        }
      }
    }
    collection.set(decorations);
    onLayout();
  }
  refreshDecorations.dispose = () => {
    disposed = true;
    cancelAnimationFrame(refreshFrame); layoutSubscription.dispose(); fontSubscription.dispose();
    collection.clear(); cursors.sync([], () => null);
    editor.changeViewZones(accessor => {
      if (activeZoneId) accessor.removeZone(activeZoneId);
      for (const id of completedZoneIds) accessor.removeZone(id);
    });
  };
  return refreshDecorations;
}
