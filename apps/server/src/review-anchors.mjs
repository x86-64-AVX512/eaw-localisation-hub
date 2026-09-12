import { Buffer } from 'node:buffer';
import * as Y from 'yjs';
import { parseLocalisationKeys } from '../../../packages/shared/src/text.mjs';

const CONTEXT_CHARACTERS = 96;
const SELECTED_TEXT_CHARACTERS = 512;

function encode(position) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

export function resolveReviewRange(document, item) {
  if (item.orphaned) return null;
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(item.startRelative, 'base64')),
      document,
    );
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(item.endRelative, 'base64')),
      document,
    );
    const text = document.getText('content');
    if (!start || !end || start.type !== text || end.type !== text) return null;
    return { start: Math.min(start.index, end.index), end: Math.max(start.index, end.index) };
  } catch {
    return null;
  }
}

function lineAt(source, position) {
  const bounded = Math.max(0, Math.min(source.length, position));
  const before = bounded > 0 && source[bounded - 1] === '\n' ? bounded - 1 : bounded;
  const start = before === 0 ? 0 : source.lastIndexOf('\n', before - 1) + 1;
  const newline = source.indexOf('\n', start);
  const end = newline < 0 ? source.length : newline;
  const key = parseLocalisationKeys(source.slice(start, end + 1))[0]?.key ?? '';
  return { start, end, key, offset: bounded - start };
}

function locatorFor(source, range) {
  const startLine = lineAt(source, range.start);
  const endLine = lineAt(source, range.end);
  const selected = source.slice(range.start, range.end);
  return {
    empty: range.start === range.end,
    startKey: startLine.key,
    endKey: endLine.key,
    startOffset: startLine.offset,
    endOffset: endLine.offset,
    before: source.slice(Math.max(0, range.start - CONTEXT_CHARACTERS), range.start),
    after: source.slice(range.end, range.end + CONTEXT_CHARACTERS),
    selected: selected.length <= SELECTED_TEXT_CHARACTERS ? selected : '',
  };
}

export function captureReviewAnchor(document, item) {
  const range = resolveReviewRange(document, item);
  if (!range) return false;
  if (range.start === 0 && range.end === 0
      && item.anchorLocator && !item.anchorLocator.empty) return false;
  const next = locatorFor(document.getText('content').toString(), range);
  const changed = JSON.stringify(item.anchorLocator ?? null) !== JSON.stringify(next);
  item.anchorLocator = next;
  return changed;
}

export function captureReviewAnchors(document, items) {
  let changed = false;
  for (const item of items) {
    if (captureReviewAnchor(document, item)) changed = true;
  }
  return changed;
}

function uniqueIndex(source, value, from = 0, to = source.length) {
  if (!value) return -1;
  const first = source.indexOf(value, from);
  if (first < 0 || first >= to) return -1;
  const second = source.indexOf(value, first + 1);
  return second < 0 || second >= to ? first : -1;
}

function keyLines(source) {
  const result = new Map();
  for (const entry of parseLocalisationKeys(source)) {
    const start = source.lastIndexOf('\n', Math.max(0, entry.index - 1)) + 1;
    const newline = source.indexOf('\n', entry.index);
    const end = newline < 0 ? source.length : newline;
    if (result.has(entry.key)) result.set(entry.key, null);
    else result.set(entry.key, { start, end });
  }
  return result;
}

function rangeFromContext(source, locator) {
  if (locator.selected) {
    const selected = uniqueIndex(source, locator.selected);
    if (selected >= 0) return { start: selected, end: selected + locator.selected.length };
  }
  if (locator.before && locator.after) {
    const before = uniqueIndex(source, locator.before);
    if (before >= 0) {
      const start = before + locator.before.length;
      const end = source.indexOf(locator.after, start);
      if (end >= start && end - start <= 16 * 1024
          && source.indexOf(locator.after, end + 1) < 0) {
        return locator.empty ? { start, end: start } : { start, end };
      }
    }
  }
  return null;
}

export function reviewRangeForLocator(source, locator) {
  if (!locator || typeof locator !== 'object') return null;
  const lines = keyLines(source);
  const startLine = locator.startKey ? lines.get(locator.startKey) : null;
  const endLine = locator.endKey ? lines.get(locator.endKey) : null;
  if (startLine && endLine) {
    let start = startLine.start + Math.max(0, Math.min(startLine.end - startLine.start, locator.startOffset));
    let end = endLine.start + Math.max(0, Math.min(endLine.end - endLine.start, locator.endOffset));
    if (end < start) [start, end] = [end, start];
    if (locator.empty) end = start;
    if (locator.selected && source.slice(start, end) !== locator.selected) {
      const selected = uniqueIndex(source, locator.selected, startLine.start, endLine.end + 1);
      if (selected >= 0) return { start: selected, end: selected + locator.selected.length };
    }
    return { start, end };
  }
  return rangeFromContext(source, locator);
}

function reanchor(text, item, range) {
  const previous = `${item.startRelative}\0${item.endRelative}\0${Boolean(item.orphaned)}`;
  if (!range) {
    item.orphaned = true;
  } else {
    item.startRelative = encode(Y.createRelativePositionFromTypeIndex(text, range.start, -1));
    item.endRelative = encode(Y.createRelativePositionFromTypeIndex(text, range.end, 0));
    delete item.orphaned;
    item.anchorLocator = locatorFor(text.toString(), range);
  }
  return previous !== `${item.startRelative}\0${item.endRelative}\0${Boolean(item.orphaned)}`;
}

export function repairReviewAnchors(document, items, { force = false } = {}) {
  const text = document.getText('content');
  const source = text.toString();
  let changed = false;
  for (const item of items) {
    const current = resolveReviewRange(document, item);
    if (!force && current && (item.anchorLocator?.empty || current.start !== current.end)) continue;
    if (reanchor(text, item, reviewRangeForLocator(source, item.anchorLocator))) changed = true;
  }
  return changed;
}
