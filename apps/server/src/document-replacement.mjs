import {
  computeSingleReplace, parseLocalisationKeys, utf8ByteOffsetToUtf16Index,
} from '../../../packages/shared/src/text.mts';

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    let end = newline < 0 ? text.length : newline + 1;
    // Keep a run of blank lines together so sparse documents stay cheap to diff.
    if (text[start] === '\n' || (text[start] === '\r' && text[start + 1] === '\n')) {
      while (text[end] === '\n' || (text[end] === '\r' && text[end + 1] === '\n')) {
        end += text[end] === '\r' ? 2 : 1;
      }
    }
    lines.push(text.slice(start, end));
    start = end;
  }
  return lines;
}

function lineIdentity(line) {
  const key = parseLocalisationKeys(line)[0]?.key;
  return key === undefined ? line.replace(/\r?\n$/u, '') : `\0${key}`;
}

// Pair occurrences in order, then keep an increasing subsequence of the pairs.
// This keeps matching bounded even when a file contains many identical lines.
function orderedLineMatches(before, after, uniqueOnly = false) {
  const positions = new Map();
  for (const [index, line] of after.entries()) {
    if (!positions.has(line)) positions.set(line, { indexes: [], used: 0 });
    const group = positions.get(line);
    if (!uniqueOnly || group.indexes.length < 2) group.indexes.push(index);
  }
  const counts = new Map();
  if (uniqueOnly) {
    for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  const tails = [];
  for (const [beforeIndex, line] of before.entries()) {
    const group = positions.get(line);
    if (!group || group.used === group.indexes.length) continue;
    if (uniqueOnly && (counts.get(line) !== 1 || group.indexes.length !== 1)) continue;
    const afterIndex = group.indexes[group.used++];
    let start = 0;
    let end = tails.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (tails[middle].afterIndex < afterIndex) start = middle + 1;
      else end = middle;
    }
    tails[start] = { beforeIndex, afterIndex, previous: tails[start - 1] };
  }
  const matches = [];
  for (let match = tails.at(-1); match; match = match.previous) matches.push(match);
  return matches.reverse();
}

function visitLineMatches(before, after, matches, visitGap, visitLine) {
  let previousIndex = 0;
  let nextIndex = 0;
  for (const { beforeIndex, afterIndex } of matches) {
    if (previousIndex !== beforeIndex || nextIndex !== afterIndex) {
      visitGap(before.slice(previousIndex, beforeIndex), after.slice(nextIndex, afterIndex));
    }
    visitLine(before[beforeIndex], after[afterIndex]);
    previousIndex = beforeIndex + 1;
    nextIndex = afterIndex + 1;
  }
  visitGap(before.slice(previousIndex), after.slice(nextIndex));
}

export function planDocumentReplacement(before, after) {
  if (before === after) return [];
  if (!before) return [{ insert: after }];
  if (!after) return [{ delete: before.length }];

  const delta = [];
  let retained = 0;
  const change = (previous, next) => {
    const edit = computeSingleReplace(previous, next);
    if (!edit) {
      retained += previous.length;
      return;
    }
    const start = utf8ByteOffsetToUtf16Index(previous, edit.positionByte);
    const end = utf8ByteOffsetToUtf16Index(previous, edit.positionByte + edit.deleteBytes);
    retained += start;
    if (retained) delta.push({ retain: retained });
    if (end > start) delta.push({ delete: end - start });
    if (edit.insertText) delta.push({ insert: edit.insertText });
    retained = previous.length - end;
  };
  const replaceGap = (previous, next) => change(previous.join(''), next.join(''));
  const alignGap = (previous, next) => {
    if (!previous.length || !next.length || (previous.length === 1 && next.length === 1)) {
      replaceGap(previous, next);
      return;
    }
    const matches = orderedLineMatches(previous.map(lineIdentity), next.map(lineIdentity));
    visitLineMatches(previous, next, matches, replaceGap, change);
  };

  const previous = splitLines(before);
  const next = splitLines(after);
  // Anchor exact, unique lines first. Match repeated and edited lines within those gaps.
  visitLineMatches(previous, next, orderedLineMatches(previous, next, true), alignGap, change);
  return delta;
}
