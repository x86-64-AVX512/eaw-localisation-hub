// A tolerant, line-oriented parser for Paradox localisation. Diagnostics are
// advisory: an unfinished edit must not prevent the rest of the file parsing.
const HEADER = /^l_[a-z_]+\s*:\s*(?:#.*)?$/iu;
const TRAILING_COMMENT = /^\s*(?:#.*)?$/u;
const ALLOWED_ESCAPES = new Set(['n', 'r', 't', '"', '\\']);

function diagnostic(code, severity, message, lineNumber, start, end, related = null) {
  return {
    code, severity, message, lineNumber,
    startColumn: start + 1, endColumn: Math.max(start + 2, end + 1),
    ...(related ? { related } : {}),
  };
}

function parseLine(line, lineNumber, diagnostics, firstKeys) {
  let start = 0;
  if (lineNumber === 1 && line.charCodeAt(0) === 0xFEFF) start = 1;
  while (line[start] === ' ' || line[start] === '\t') start += 1;
  if (start >= line.length || line[start] === '#' || HEADER.test(line.slice(start))) return;

  const colon = line.indexOf(':', start);
  if (colon < 0) return;
  const key = line.slice(start, colon).trimEnd();
  if (!key || /[\s#"\r\n]/u.test(key)) return;
  const previous = firstKeys.get(key);
  if (previous) diagnostics.push(diagnostic(
    'duplicate-key', 'error', `Ключ «${key}» повторяется (первое объявление: строка ${previous.lineNumber}).`,
    lineNumber, start, start + key.length, previous,
  ));
  else firstKeys.set(key, { lineNumber, startColumn: start + 1, endColumn: start + key.length + 1 });

  let cursor = colon + 1;
  while (cursor < line.length && /[0-9]/u.test(line[cursor])) cursor += 1;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
  if (line[cursor] !== '"') {
    const position = cursor < line.length ? cursor : colon;
    diagnostics.push(diagnostic(
      'missing-opening-quote', 'error', `У ключа «${key}» нет открывающей кавычки значения.`,
      lineNumber, position, position + 1,
    ));
    return;
  }

  const opening = cursor;
  let closing = -1;
  for (cursor += 1; cursor < line.length; cursor += 1) {
    const character = line[cursor];
    if (character === '\\') {
      const escaped = line[cursor + 1];
      if (escaped === undefined) {
        diagnostics.push(diagnostic(
          'unfinished-escape', 'warning', 'Незавершённая escape-последовательность.',
          lineNumber, cursor, cursor + 1,
        ));
      } else {
        if (!ALLOWED_ESCAPES.has(escaped)) diagnostics.push(diagnostic(
          'unknown-escape', 'warning', `Неизвестная escape-последовательность \\${escaped}.`,
          lineNumber, cursor, cursor + 2,
        ));
        cursor += 1;
      }
      continue;
    }
    // Legacy files can contain unescaped quotes inside the value. Only a
    // quote followed by whitespace or a comment is an unambiguous terminator.
    if (character === '"' && TRAILING_COMMENT.test(line.slice(cursor + 1))) {
      closing = cursor;
      break;
    }
  }
  if (closing < 0) diagnostics.push(diagnostic(
    'unclosed-quote', 'error', `У ключа «${key}» не закрыта кавычка значения.`,
    lineNumber, opening, line.length,
  ));
}

export function parseLocalisationDiagnostics(source) {
  const diagnostics = [];
  const firstKeys = new Map();
  const lines = String(source ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    parseLine(line, index + 1, diagnostics, firstKeys);
  }
  return diagnostics;
}
