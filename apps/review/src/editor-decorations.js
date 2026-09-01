import { colorClass, decodeBase64, safeColor } from './review-utilities.js';
import { createPresenceCursorLayer } from './presence-cursors.js';
import { suggestionTraceParts } from '../../../packages/shared/src/suggestion-trace.mjs';

export function completedSuggestionZoneAfterLine(range) {
  const start = range.getStartPosition();
  const end = range.getEndPosition();
  return Math.max(start.lineNumber, end.lineNumber);
}

export function createDecorationRenderer({ monaco, state, editor, rangeFromBytes, onLayout }) {
  const collection = editor.createDecorationsCollection();
  const cursors = createPresenceCursorLayer({ monaco, editor });
  let activeZoneId;
  let activeZoneKey = '';
  let completedZoneIds = [];
  let completedZoneKey = '';

  function textRuns(text) {
    const runs = [];
    const expression = /[^\r\n]+/gu;
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      runs.push({ offset: match.index, text: match[0] });
    }
    return runs;
  }

  function syncActiveOriginalZone(projection) {
    const original = projection?.baseText.slice(projection.start, projection.previousEnd) ?? '';
    const multiline = original.includes('\n');
    const nextKey = multiline
      ? `${projection.start}:${projection.previousEnd}:${projection.color}:${original}`
      : '';
    if (nextKey === activeZoneKey) return;
    editor.changeViewZones((accessor) => {
      if (activeZoneId) accessor.removeZone(activeZoneId);
      activeZoneId = undefined;
      activeZoneKey = nextKey;
      if (!multiline) return;
      const position = editor.getModel().getPositionAt(projection.start);
      const domNode = document.createElement('div');
      domNode.className = 'active-suggestion-original-zone';
      domNode.style.setProperty('--author-color', safeColor(projection.color));
      domNode.textContent = original;
      activeZoneId = accessor.addZone({
        afterLineNumber: Math.max(0, position.lineNumber - 1),
        heightInLines: Math.max(2, original.split('\n').length),
        domNode,
      });
    });
  }

  function syncCompletedMultilineZones(items, resolvedRange) {
    const candidates = items.filter(({ item, replacement }) => item.id !== state.editingSuggestionId
      && item.status === 'open' && replacement.includes('\n'));
    const nextKey = candidates.map(({ item, replacement }) => [
      item.id, item.startByte, item.endByte, item.status, item.color, replacement,
    ].join(':')).join('|');
    if (nextKey === completedZoneKey) return;
    editor.changeViewZones((accessor) => {
      for (const id of completedZoneIds) accessor.removeZone(id);
      completedZoneIds = [];
      completedZoneKey = nextKey;
      for (const { item, replacement } of candidates) {
        const range = resolvedRange(item.startByte, item.endByte);
        if (!range) continue;
        const domNode = document.createElement('div');
        domNode.className = 'multiline-suggestion-zone';
        domNode.style.setProperty('--author-color', safeColor(item.color));
        domNode.setAttribute('aria-label', 'Предлагаемый перенос строки');
        domNode.textContent = replacement.replace(/^\n|\n$/gu, '');
        completedZoneIds.push(accessor.addZone({
          // The proposed line belongs after the struck original. Placing a
          // leading-newline replacement before a column-one range reverses
          // the visual order (replacement above deletion).
          afterLineNumber: completedSuggestionZoneAfterLine(range),
          heightInLines: Math.max(1, (replacement.match(/\n/gu) ?? []).length),
          domNode,
        }));
      }
    });
  }

  return function refreshDecorations() {
    const decorations = [];
    const resolvedRange = (start, end) => {
      try { return rangeFromBytes(start, end); } catch { return null; }
    };
    const activeProjection = state.suggestionProjection;
    syncActiveOriginalZone(activeProjection);
    if (activeProjection) {
      const model = editor.getModel();
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
              hoverMessage: { value: `**${activeProjection.author}** редактирует правку` },
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
      resolvedRange(positionByte, positionByte)?.getStartPosition());
    for (const item of state.reservations.values()) {
      if (item.status === 'orphaned' || item.startByte === item.endByte) continue;
      const reservationClass = colorClass('reservation-range', item.color,
        (color) => `background:${color}25;border-bottom:1px solid ${color}`);
      const delegated = item.createdBy && item.createdBy !== item.assignee ? ` · создал: ${item.createdBy}` : '';
      const range = resolvedRange(item.startByte, item.endByte);
      if (range) decorations.push({ range, options: {
        inlineClassName: reservationClass,
        hoverMessage: { value: `**Бронь: ${item.assignee}**${delegated}${item.comment ? `  \n${item.comment}` : ''}` },
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
      const replacement = decodedReplacement || '[удалить]';
      const range = resolvedRange(item.startByte, item.endByte);
      if (range) {
        const model = editor.getModel();
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
              hoverMessage: { value: `**${item.author}** предлагает: ${replacement}` },
            } });
          }
        }
      }
    }
    collection.set(decorations);
    onLayout();
  };
}
