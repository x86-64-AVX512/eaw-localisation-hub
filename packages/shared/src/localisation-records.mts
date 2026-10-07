// Read-only analysis model. Do not use this stricter reader for CRDT edits or
// materialisation: unfinished editor declarations must retain their identity.
export interface LocalisationRecord {
  key: string;
  lineNumber: number;
  keyStart: number;
  keyEnd: number;
  colon: number;
  opening: number;
  closing: number;
  value: string;
  fault: 'missing-colon' | 'invalid-key' | 'missing-opening-quote' | 'unclosed-quote' | null;
}

export function readLocalisationLine(line: string, lineNumber: number): LocalisationRecord | null {
  let start = lineNumber === 1 && line.startsWith('\uFEFF') ? 1 : 0;
  while (line[start] === ' ' || line[start] === '\t') start += 1;
  const body = line.slice(start);
  if (!body || body.startsWith('#') || /^l_[a-z_]+\s*:?(?:\s*#.*|\s*)$/iu.test(body)) return null;
  const colon = line.indexOf(':', start);
  const key = (colon < 0 ? body.split(/\s/u)[0] : line.slice(start, colon)).trimEnd();
  const record: LocalisationRecord = { key, lineNumber, keyStart: start,
    keyEnd: start + key.length, colon, opening: -1, closing: -1, value: '', fault: null };
  if (colon < 0) { record.fault = 'missing-colon'; return record; }
  if (!/^[A-Za-z0-9_.\-']+$/u.test(key)) { record.fault = 'invalid-key'; return record; }
  let cursor = colon + 1;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
  while (/[0-9]/u.test(line[cursor] ?? '') && cursor < line.length) cursor += 1;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
  record.opening = cursor;
  if (line[cursor] !== '"') { record.fault = 'missing-opening-quote'; return record; }
  // Legacy localisation is not strict YAML: internal unescaped quotes exist.
  // A terminator before an inline comment ends the value, including when the
  // comment itself contains quotes. Other internal unescaped quotes are kept.
  for (cursor += 1; cursor < line.length; cursor += 1) {
    if (line[cursor] === '\\') { cursor += 1; continue; }
    if (line[cursor] === '"' && /^\s*(?:#.*)?$/u.test(line.slice(cursor + 1))) {
      record.closing = cursor; break;
    }
  }
  if (record.closing < 0) record.fault = 'unclosed-quote';
  record.value = line.slice(record.opening + 1, record.closing < 0 ? line.length : record.closing);
  return record;
}

export function parseLocalisationRecords(source: string): LocalisationRecord[] {
  return source.split(/\r?\n/u).flatMap((line, index) => {
    const record = readLocalisationLine(line, index + 1);
    return record ? [record] : [];
  });
}

export function localisationLanguage(filePath: string, text = ''): string {
  const normalised = filePath.replaceAll('\\', '/');
  return (/_l_([a-z_]+)\.ya?ml$/iu.exec(normalised)?.[1]
    ?? /(?:^|\/)localisation\/(?:replace\/)?([a-z_]+)\//iu.exec(normalised)?.[1]
    ?? /^\uFEFF?\s*l_([a-z_]+):/iu.exec(text)?.[1] ?? '').toLowerCase();
}
