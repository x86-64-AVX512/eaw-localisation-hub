// A tolerant, line-oriented parser for Paradox localisation. Diagnostics are
// advisory: an unfinished edit must not prevent the rest of the file parsing.
import { readLocalisationLine, parseLocalisationRecords } from './localisation-records.mts';
import { dynamicExpressionEnd } from './localisation-markup.mts';
import { suspiciousLocalisationFormat } from './localisation-format.mts';
import { localisationSemanticDiagnostics } from './localisation-semantics.mts';
import { diagnosticMessage } from './diagnostic-message.mts';
import type { DiagnosticMessage } from './diagnostic-message.mts';
const HEADER = /^l_([a-z_]+)\s*:\s*(?:#.*)?$/iu;
const HEADER_LIKE = /^l_[a-z_]+/iu;
const TRAILING_COMMENT = /^\s*(?:#.*)?$/u;
const ALLOWED_ESCAPES = new Set(['n', 'N', 't', 'T', '"', '\\']);
const REFERENCE_NAME = /^[\p{L}\p{N}_.:-]+$/u;
const COLOUR_CODE = /^[A-Za-z0-9]$/u;
const ICON_NAME = /^[\p{L}\p{N}_]+/u;

interface RelatedLocation {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
}

export interface LocalisationDiagnostic extends RelatedLocation, DiagnosticMessage {
  code: string;
  severity: 'error' | 'warning' | 'info';
  related?: RelatedLocation;
}

interface LocalisationReference {
  key: string;
  lineNumber: number;
  start: number;
  end: number;
}

function diagnostic(code: string, severity: LocalisationDiagnostic['severity'], message: string | DiagnosticMessage,
  lineNumber: number, start: number, end: number,
  related: RelatedLocation | null = null): LocalisationDiagnostic {
  return {
    code, severity, ...(typeof message === 'string' ? { message } : message), lineNumber,
    startColumn: start + 1, endColumn: Math.max(start + 2, end + 1),
    ...(related ? { related } : {}),
  };
}

function expectedLanguageFromPath(filePath: string): string {
  const normalised = String(filePath ?? '').replaceAll('\\', '/');
  const filename = /_l_([a-z_]+)\.ya?ml$/iu.exec(normalised)?.[1];
  const directory = /(?:^|\/)localisation\/(?:replace\/)?([a-z_]+)\//iu.exec(normalised)?.[1];
  return (filename ?? directory ?? '').toLowerCase();
}

function checkHeader(lines: string[], diagnostics: LocalisationDiagnostic[], filePath: string): void {
  const expected = expectedLanguageFromPath(filePath);
  const first = lines.findIndex((line) => {
    const body = line.replace(/^\uFEFF/u, '').trim();
    return body && !body.startsWith('#');
  });
  if (first < 0) {
    diagnostics.push(diagnostic('missing-header', 'error', expected
      ? diagnosticMessage('В начале файла требуется заголовок {0}.', `l_${expected}:`)
      : 'В начале файла требуется заголовок l_<язык>:.', 1, 0, 1));
    return;
  }
  const line = lines[first].replace(/^\uFEFF/u, '');
  const start = line.search(/\S/u);
  const body = line.slice(start);
  const match = HEADER.exec(body);
  if (match) {
    if (expected && match[1].toLowerCase() !== expected) diagnostics.push(diagnostic(
      'wrong-language-header', 'error', diagnosticMessage('Для этого файла нужен заголовок l_{0}:, а не l_{1}:.', expected, match[1]),
      first + 1, start, start + match[0].length,
    ));
    return;
  }
  diagnostics.push(diagnostic(
    HEADER_LIKE.test(body) ? 'malformed-header' : 'missing-header', 'error',
    HEADER_LIKE.test(body)
      ? expected ? diagnosticMessage('Неверный заголовок локализации: ожидается {0}.', `l_${expected}:`)
        : 'Неверный заголовок локализации: ожидается l_<язык>:.'
      : expected ? diagnosticMessage('В начале файла требуется заголовок {0}.', `l_${expected}:`)
        : 'В начале файла требуется заголовок l_<язык>:.',
    first + 1, start, Math.min(line.length, start + Math.max(1, body.indexOf(':') + 1)),
  ));
}

function scanReference(line: string, lineNumber: number, cursor: number, end: number,
  diagnostics: LocalisationDiagnostic[], references: LocalisationReference[]): number {
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
    if (formatter && suspiciousLocalisationFormat(formatter)) diagnostics.push(diagnostic(
      'suspicious-reference-formatter', 'warning', 'Подозрительный формат: повтор % должен быть соседним; после точки нужна цифра.',
      lineNumber, cursor + separator + 2, closing,
    ));
    references.push({ key, lineNumber, start: cursor, end: closing + 1 });
  }
  return closing;
}

function bracketCandidate(line: string, cursor: number, end: number): boolean {
  const next = line[cursor + 1];
  if (next === ']' || next === '[' || next === '(') return true;
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

function scanBracket(line: string, lineNumber: number, cursor: number, end: number,
  diagnostics: LocalisationDiagnostic[]): number {
  if (!bracketCandidate(line, cursor, end)) return cursor;
  if (line[cursor + 1] === '(') {
    const closing = dynamicExpressionEnd(line.slice(0, end), cursor);
    if (closing >= 0) return closing;
    diagnostics.push(diagnostic('unclosed-conditional-loc', 'warning',
      'Не закрыто условное выражение локализации.', lineNumber, cursor, Math.min(end, cursor + 2)));
    return cursor;
  }
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
    if (formatter !== null && (/\s/u.test(formatter)
      || suspiciousLocalisationFormat(formatter))) diagnostics.push(diagnostic(
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

function scanValueMarkup(line: string, lineNumber: number, start: number, end: number,
  diagnostics: LocalisationDiagnostic[], references: LocalisationReference[]): void {
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
          'stray-colour-reset', 'info', 'Сброс цвета §! без тега в этой строке; цвет может приходить из другой строки.',
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
      // This form occurs in the shipped game. Its runtime parameter cannot be
      // validated as a literal icon name, nor as an absent global key.
      const parameterised = /^\$[^$\r\n]+\$£/u.exec(line.slice(cursor + 1, end));
      if (parameterised) { cursor += parameterised[0].length; continue; }
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
    'unclosed-colour-tag', 'info', 'Цвет не сброшен в этой строке; §! может находиться в другом фрагменте.',
    lineNumber, colourStart, Math.min(end, colourStart + 2),
  ));
}

function parseLine(line: string, lineNumber: number, diagnostics: LocalisationDiagnostic[],
  firstKeys: Map<string, RelatedLocation>, references: LocalisationReference[]): void {
  let start = 0;
  if (lineNumber === 1 && line.charCodeAt(0) === 0xFEFF) start = 1;
  while (line[start] === ' ' || line[start] === '\t') start += 1;
  if (start >= line.length || line[start] === '#' || HEADER.test(line.slice(start))) return;

  const record = readLocalisationLine(line, lineNumber);
  if (!record) return;
  const { colon, key } = record;
  if (record.fault === 'missing-colon' || record.fault === 'invalid-key') {
    diagnostics.push(diagnostic(record.fault, 'error', record.fault === 'missing-colon'
      ? 'В записи локализации отсутствует двоеточие. Игра может не загрузить последующие записи.'
      : 'Недопустимое имя ключа: разрешены латинские буквы, цифры, _, ., - и апостроф. Игра может не загрузить последующие записи.',
    lineNumber, start, Math.max(start + 1, record.keyEnd)));
    return;
  }
  const previous = firstKeys.get(key);
  if (previous) diagnostics.push(diagnostic(
    'duplicate-key', 'error', diagnosticMessage('Ключ «{0}» повторяется (первое объявление: строка {1}).', key, previous.lineNumber),
    lineNumber, start, start + key.length, previous,
  ));
  else firstKeys.set(key, { lineNumber, startColumn: start + 1, endColumn: start + key.length + 1 });

  let cursor = record.opening;
  if (line[cursor] !== '"') {
    const position = cursor < line.length ? cursor : colon;
    diagnostics.push(diagnostic(
      'missing-opening-quote', 'error', diagnosticMessage('У ключа «{0}» нет открывающей кавычки значения.', key),
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
          'unknown-escape', 'warning', diagnosticMessage('Неизвестная escape-последовательность \\{0}.', escaped),
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
    'unclosed-quote', 'error', diagnosticMessage('У ключа «{0}» не закрыта кавычка значения.', key),
    lineNumber, opening, line.length,
  ));
  scanValueMarkup(line, lineNumber, opening + 1, closing < 0 ? line.length : closing, diagnostics, references);
}

export function parseLocalisationDiagnostics(source: unknown, {
  filePath = '', knownKeys = null, knownPrefixes = null, knownGetters = null, knownParameters = null,
}: { filePath?: string; knownKeys?: ReadonlySet<string> | null; knownPrefixes?: ReadonlySet<string> | null;
  knownGetters?: ReadonlySet<string> | null; knownParameters?: ReadonlySet<string> | null } = {}): LocalisationDiagnostic[] {
  const diagnostics: LocalisationDiagnostic[] = [];
  const firstKeys = new Map<string, RelatedLocation>();
  const references: LocalisationReference[] = [];
  const lines = String(source ?? '').split('\n');
  checkHeader(lines, diagnostics, filePath);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    parseLine(line, index + 1, diagnostics, firstKeys, references);
  }
  const loaderFailure = diagnostics.some((issue) => issue.severity === 'error' && issue.code !== 'duplicate-key');
  if (knownKeys && knownPrefixes && !loaderFailure) {
    for (const reference of references) {
      if (knownParameters?.has(reference.key) || knownKeys.has(reference.key) || firstKeys.has(reference.key)) continue;
      const prefix = /^[A-Z0-9]{2,5}(?=_)/u.exec(reference.key)?.[0];
      if (!prefix || !knownPrefixes.has(prefix)) continue;
      diagnostics.push(diagnostic(
        'unresolved-local-reference', 'info',
        diagnosticMessage('Ключ «{0}» не найден в локализации мода для этого языка; он может быть параметром или определяться базовой игрой.', reference.key),
        reference.lineNumber, reference.start, reference.end,
      ));
    }
  }
  diagnostics.push(...localisationSemanticDiagnostics(parseLocalisationRecords(String(source ?? '')),
    { knownGetters, knownParameters }));
  return diagnostics;
}
