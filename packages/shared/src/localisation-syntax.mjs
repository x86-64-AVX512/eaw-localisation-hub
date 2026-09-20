// A tolerant, line-oriented parser for Paradox localisation. Diagnostics are
// advisory: an unfinished edit must not prevent the rest of the file parsing.
const HEADER = /^l_([a-z_]+)\s*:\s*(?:#.*)?$/iu;
const HEADER_LIKE = /^l_[a-z_]+/iu;
const TRAILING_COMMENT = /^\s*(?:#.*)?$/u;
const ALLOWED_ESCAPES = new Set(['n', 'r', 't', '"', '\\']);
const REFERENCE_NAME = /^[\p{L}\p{N}_.:-]+$/u;
const COLOUR_CODE = /^[A-Za-z0-9]$/u;
const ICON_NAME = /^[\p{L}\p{N}_]+/u;

function diagnostic(code, severity, message, lineNumber, start, end, related = null) {
  return {
    code, severity, message, lineNumber,
    startColumn: start + 1, endColumn: Math.max(start + 2, end + 1),
    ...(related ? { related } : {}),
  };
}

function expectedLanguageFromPath(filePath) {
  const normalised = String(filePath ?? '').replaceAll('\\', '/');
  const filename = /_l_([a-z_]+)\.ya?ml$/iu.exec(normalised)?.[1];
  const directory = /(?:^|\/)localisation\/(?:replace\/)?([a-z_]+)\//iu.exec(normalised)?.[1];
  return (filename ?? directory ?? '').toLowerCase();
}

function checkHeader(lines, diagnostics, filePath) {
  const expected = expectedLanguageFromPath(filePath);
  const first = lines.findIndex((line) => {
    const body = line.replace(/^\uFEFF/u, '').trim();
    return body && !body.startsWith('#');
  });
  if (first < 0) {
    diagnostics.push(diagnostic('missing-header', 'error',
      `В начале файла требуется заголовок ${expected ? `l_${expected}:` : 'l_<язык>:'}.`, 1, 0, 1));
    return;
  }
  const line = lines[first].replace(/^\uFEFF/u, '');
  const start = line.search(/\S/u);
  const body = line.slice(start);
  const match = HEADER.exec(body);
  if (match) {
    if (expected && match[1].toLowerCase() !== expected) diagnostics.push(diagnostic(
      'wrong-language-header', 'error', `Для этого файла нужен заголовок l_${expected}:, а не l_${match[1]}:.`,
      first + 1, start, start + match[0].length,
    ));
    return;
  }
  diagnostics.push(diagnostic(
    HEADER_LIKE.test(body) ? 'malformed-header' : 'missing-header', 'error',
    HEADER_LIKE.test(body)
      ? `Неверный заголовок локализации: ожидается ${expected ? `l_${expected}:` : 'l_<язык>:'}.`
      : `В начале файла требуется заголовок ${expected ? `l_${expected}:` : 'l_<язык>:'}.`,
    first + 1, start, Math.min(line.length, start + Math.max(1, body.indexOf(':') + 1)),
  ));
}

function scanReference(line, lineNumber, cursor, end, diagnostics, references) {
  let closing = -1; let boundary = end;
  for (let index = cursor + 1; index < end; index += 1) {
    if (line[index] === '\\') { index += 1; continue; }
    if (line[index] === '$') { closing = index; break; }
    if ('§[£'.includes(line[index])) { boundary = index; break; }
  }
  if (closing < 0) {
    if (/[\p{L}\p{N}_]/u.test(line[cursor + 1] ?? '') && boundary > cursor + 1) diagnostics.push(diagnostic(
      'unclosed-reference', 'warning', 'Не закрыта ссылка на ключ локализации ($...$).',
      lineNumber, cursor, Math.min(end, cursor + 2),
    ));
    else if (/[\p{L}_][\p{L}\p{N}_.:-]*$/u.test(line.slice(0, cursor))) diagnostics.push(diagnostic(
      'orphan-reference-end', 'warning', 'Лишний символ $ после имени ссылки.',
      lineNumber, cursor, cursor + 1,
    ));
    return cursor;
  }
  const body = line.slice(cursor + 1, closing);
  const separator = body.indexOf('|');
  const key = separator < 0 ? body : body.slice(0, separator);
  const formatter = separator < 0 ? null : body.slice(separator + 1);
  if (!body) diagnostics.push(diagnostic(
    'empty-reference', 'warning', 'Пустая ссылка на ключ локализации.',
    lineNumber, cursor, closing + 1,
  ));
  else if (!REFERENCE_NAME.test(key) || /\s/u.test(body)) diagnostics.push(diagnostic(
    'malformed-reference', 'warning', 'Неверный формат ссылки на ключ локализации.',
    lineNumber, cursor, closing + 1,
  ));
  else {
    // An empty formatter is used by HOI4; it is not a syntax error.
    if (formatter && /%[a-z]/u.test(formatter)) diagnostics.push(diagnostic(
      'suspicious-reference-formatter', 'warning', 'Подозрительный формат числа после %.',
      lineNumber, cursor + separator + 2, closing,
    ));
    references.push({ key, lineNumber, start: cursor, end: closing + 1 });
  }
  return closing;
}

function bracketCandidate(line, cursor, end) {
  const next = line[cursor + 1];
  if (next === ']' || next === '[') return true;
  let stop = cursor + 1;
  while (stop < end && line[stop] !== '[' && line[stop] !== ']') stop += 1;
  const prefix = line.slice(cursor + 1, stop);
  const trimmed = prefix.trim();
  if (/^[!?]/u.test(trimmed)) return true;
  if (/^(?:Get[A-Za-z0-9_]*|(?:Root|From|Prev|This|ROOT|FROM|PREV|THIS)\.)/u.test(trimmed)) return true;
  // Ordinary prose in square brackets is common. Treat it as dynamic loc only
  // when its contents resemble an expression, including numeric scopes.
  return /^[A-Za-z0-9_][A-Za-z0-9_.:@^|+%=-]*$/u.test(prefix);
}

function scanBracket(line, lineNumber, cursor, end, diagnostics) {
  if (!bracketCandidate(line, cursor, end)) return cursor;
  let closing = -1; let nested = -1;
  for (let index = cursor + 1; index < end; index += 1) {
    if (line[index] === '\\') { index += 1; continue; }
    if (line[index] === '[') { nested = index; break; }
    if (line[index] === ']') { closing = index; break; }
  }
  const variable = line.slice(cursor + 1).trimStart().startsWith('?');
  if (nested >= 0) {
    diagnostics.push(diagnostic(
      'nested-dynamic-loc', 'warning', 'Новая [ началась до закрытия предыдущего выражения.',
      lineNumber, cursor, nested + 1,
    ));
    return cursor;
  }
  if (closing < 0) {
    diagnostics.push(diagnostic(
      variable ? 'unclosed-variable' : 'unclosed-command', 'warning',
      variable ? 'Не закрыта переменная локализации [?…].' : 'Не закрыто выражение локализации в квадратных скобках.',
      lineNumber, cursor, Math.min(end, cursor + 2),
    ));
    return cursor;
  }
  const body = line.slice(cursor + 1, closing);
  if (!body) diagnostics.push(diagnostic(
    'empty-dynamic-loc', 'warning', 'Пустое выражение локализации [].',
    lineNumber, cursor, closing + 1,
  ));
  else if (body.trim() !== body) diagnostics.push(diagnostic(
    'dynamic-loc-whitespace', 'warning', 'Лишний пробел внутри выражения локализации.',
    lineNumber, cursor, closing + 1,
  ));
  const expression = body.trim();
  if (expression.startsWith('?')) {
    const separator = expression.indexOf('|');
    const name = expression.slice(1, separator < 0 ? undefined : separator);
    const formatter = separator < 0 ? null : expression.slice(separator + 1);
    if (!name || name.includes('..') || /^[@:^]/u.test(name) || /[.@:^]$/u.test(name)
      || /\s/u.test(name)) diagnostics.push(diagnostic(
      'malformed-variable', 'warning', 'Неверное имя переменной или пустой сегмент после разделителя.',
      lineNumber, cursor, closing + 1,
    ));
    if (formatter !== null && (!formatter || /\s/u.test(formatter)
      || /%[a-z]/u.test(formatter))) diagnostics.push(diagnostic(
      'malformed-variable-format', 'warning', 'Неверный формат переменной после |.',
      lineNumber, cursor, closing + 1,
    ));
  } else if (expression.startsWith('!')) {
    if (expression.length === 1 || /\s/u.test(expression) || /[.@:^]$/u.test(expression)) diagnostics.push(diagnostic(
      'malformed-scripted-gui', 'warning', 'Неверное имя scripted GUI.',
      lineNumber, cursor, closing + 1,
    ));
  } else if (expression.includes('..') || expression.startsWith('.') || expression.endsWith('.')) diagnostics.push(diagnostic(
    'malformed-scope-access', 'warning', 'Пустой сегмент в обращении к scope/getter.',
    lineNumber, cursor, closing + 1,
  ));
  return closing;
}

function scanValueMarkup(line, lineNumber, start, end, diagnostics, references) {
  let colourStart = -1;
  for (let cursor = start; cursor < end; cursor += 1) {
    const character = line[cursor];
    if (character === '\\') { cursor += 1; continue; }
    if (character === '$') {
      cursor = scanReference(line, lineNumber, cursor, end, diagnostics, references);
      continue;
    }
    if (character === '§') {
      const code = line[cursor + 1];
      if (code === '[') {
        if (colourStart < 0) colourStart = cursor;
        const closing = line.indexOf(']', cursor + 2);
        if (closing < 0 || closing >= end) diagnostics.push(diagnostic(
          'unclosed-dynamic-colour', 'warning', 'Не закрыто выражение динамического цвета §[...].',
          lineNumber, cursor, Math.min(end, cursor + 2),
        ));
        else cursor = closing;
      } else if (code === '!') {
        if (colourStart < 0) diagnostics.push(diagnostic(
          'stray-colour-reset', 'warning', 'Сброс цвета §! без предшествующего цветового тега.',
          lineNumber, cursor, cursor + 2,
        ));
        colourStart = -1;
        cursor += 1;
      } else if (code && COLOUR_CODE.test(code)) {
        if (colourStart < 0) colourStart = cursor;
        cursor += 1;
      } else {
        diagnostics.push(diagnostic(
          'invalid-colour-tag', 'warning', 'После § ожидается код цвета, §! или §[...].',
          lineNumber, cursor, Math.min(end, cursor + 2),
        ));
        if (code) cursor += 1;
      }
      continue;
    }
    if (character === '£') {
      const name = ICON_NAME.exec(line.slice(cursor + 1, end))?.[0];
      if (!name) diagnostics.push(diagnostic(
        'invalid-icon-tag', 'warning', 'После £ ожидается имя иконки.',
        lineNumber, cursor, Math.min(end, cursor + 2),
      ));
      else {
        cursor += name.length;
        if (line[cursor + 1] === '£') cursor += 1;
      }
      continue;
    }
    if (character === '[') {
      cursor = scanBracket(line, lineNumber, cursor, end, diagnostics);
      continue;
    }
    if (character === ']') {
      const before = line.slice(start, cursor);
      if (before.lastIndexOf('[') <= before.lastIndexOf(']')
        && /(?:Get[A-Za-z_][A-Za-z0-9_]*|(?:Root|From|Prev|This)\.[A-Za-z_][A-Za-z0-9_]*|[?!][A-Za-z_][A-Za-z0-9_.@|+%=-]*)$/u.test(before)) diagnostics.push(diagnostic(
        'orphan-dynamic-end', 'warning', 'Лишняя ] после выражения локализации.',
        lineNumber, cursor, cursor + 1,
      ));
    }
  }
  if (colourStart >= 0) diagnostics.push(diagnostic(
    'unclosed-colour-tag', 'warning', 'Цветовой тег не сброшен через §!.',
    lineNumber, colourStart, Math.min(end, colourStart + 2),
  ));
}

function parseLine(line, lineNumber, diagnostics, firstKeys, references) {
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
  scanValueMarkup(line, lineNumber, opening + 1, closing < 0 ? line.length : closing, diagnostics, references);
}

export function parseLocalisationDiagnostics(source, {
  filePath = '', knownKeys = null, knownPrefixes = null,
} = {}) {
  const diagnostics = [];
  const firstKeys = new Map();
  const references = [];
  const lines = String(source ?? '').split('\n');
  checkHeader(lines, diagnostics, filePath);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    parseLine(line, index + 1, diagnostics, firstKeys, references);
  }
  if (knownKeys && knownPrefixes) {
    for (const reference of references) {
      if (knownKeys.has(reference.key) || firstKeys.has(reference.key)) continue;
      const prefix = /^[A-Z0-9]{2,5}(?=_)/u.exec(reference.key)?.[0];
      if (!prefix || !knownPrefixes.has(prefix)) continue;
      diagnostics.push(diagnostic(
        'unresolved-local-reference', 'info',
        `Ключ «${reference.key}» не найден в локализациях мода; он может определяться базовой игрой.`,
        reference.lineNumber, reference.start, reference.end,
      ));
    }
  }
  return diagnostics;
}
