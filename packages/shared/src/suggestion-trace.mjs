const MAX_TRACE_BYTES = 64 * 1024;

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

export function parseSuggestionTrace(traceJson, original, replacement) {
  if (!traceJson) return null;
  if (typeof traceJson !== 'string' || byteLength(traceJson) > MAX_TRACE_BYTES) {
    throw new TypeError('Suggestion trace exceeds its size limit');
  }
  let encoded;
  try { encoded = JSON.parse(traceJson); } catch { throw new TypeError('Suggestion trace must be valid JSON'); }
  if (!Array.isArray(encoded) || encoded.length > replacement.length + 1) {
    throw new TypeError('Suggestion trace must be a bounded array');
  }
  const spans = [];
  let replacementOffset = 0;
  let previousOriginalEnd = 0;
  for (const value of encoded) {
    if (!Array.isArray(value) || value.length !== 2
      || !Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1]) || value[1] <= 0) {
      throw new TypeError('Suggestion trace span is invalid');
    }
    const [originalStart, length] = value;
    if (replacementOffset + length > replacement.length) throw new TypeError('Suggestion trace exceeds replacement text');
    if (originalStart >= 0) {
      if (originalStart < previousOriginalEnd || originalStart + length > original.length
        || replacement.slice(replacementOffset, replacementOffset + length)
          !== original.slice(originalStart, originalStart + length)) {
        throw new TypeError('Suggestion trace does not match its text');
      }
      previousOriginalEnd = originalStart + length;
    } else if (originalStart !== -1) {
      throw new TypeError('Suggestion trace source is invalid');
    }
    spans.push({ originalStart, length, replacementOffset });
    replacementOffset += length;
  }
  if (replacementOffset !== replacement.length) throw new TypeError('Suggestion trace is incomplete');
  return spans;
}

export function createSuggestionTrace(original, replacement, origins, baseStart = 0) {
  if (!Array.isArray(origins) || origins.length !== replacement.length) return '';
  const encoded = [];
  for (let index = 0; index < origins.length;) {
    const absoluteOrigin = origins[index];
    const relativeOrigin = Number.isSafeInteger(absoluteOrigin) && absoluteOrigin >= baseStart
      ? absoluteOrigin - baseStart : -1;
    let length = 1;
    while (index + length < origins.length) {
      const nextAbsolute = origins[index + length];
      const nextRelative = Number.isSafeInteger(nextAbsolute) && nextAbsolute >= baseStart
        ? nextAbsolute - baseStart : -1;
      if (relativeOrigin === -1 ? nextRelative !== -1 : nextRelative !== relativeOrigin + length) break;
      length += 1;
    }
    encoded.push([relativeOrigin, length]);
    index += length;
  }
  const traceJson = JSON.stringify(encoded);
  parseSuggestionTrace(traceJson, original, replacement);
  return traceJson;
}

export function suggestionTraceParts(original, replacement, traceJson) {
  const spans = parseSuggestionTrace(traceJson, original, replacement);
  if (!spans) return [
    ...(original ? [{ kind: 'delete', text: original }] : []),
    ...(replacement ? [{ kind: 'insert', text: replacement }] : []),
  ];
  const parts = [];
  let originalOffset = 0;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (span.originalStart >= 0) {
      if (span.originalStart > originalOffset) {
        parts.push({ kind: 'delete', text: original.slice(originalOffset, span.originalStart) });
      }
      parts.push({
        kind: 'equal',
        text: replacement.slice(span.replacementOffset, span.replacementOffset + span.length),
      });
      originalOffset = span.originalStart + span.length;
    } else {
      const nextOriginal = spans.slice(index + 1).find((candidate) => candidate.originalStart >= 0);
      const deletionEnd = nextOriginal?.originalStart ?? original.length;
      if (deletionEnd > originalOffset) {
        parts.push({ kind: 'delete', text: original.slice(originalOffset, deletionEnd) });
        originalOffset = deletionEnd;
      }
      parts.push({
        kind: 'insert',
        text: replacement.slice(span.replacementOffset, span.replacementOffset + span.length),
      });
    }
  }
  if (originalOffset < original.length) parts.push({ kind: 'delete', text: original.slice(originalOffset) });
  return parts;
}

export function suggestionTraceOrigins(original, replacement, traceJson, baseStart = 0) {
  const spans = parseSuggestionTrace(traceJson, original, replacement);
  if (!spans) return Array.from({ length: replacement.length }, () => -1);
  const origins = [];
  for (const span of spans) {
    for (let offset = 0; offset < span.length; offset += 1) {
      origins.push(span.originalStart < 0 ? -1 : baseStart + span.originalStart + offset);
    }
  }
  return origins;
}
