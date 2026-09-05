const LOCALISATION_PREFIX = /^(\s*)([^#\s][^:]*?)(:\d+)(\s+")/u;

function parseLocalisationSourceLine(content) {
  const prefix = LOCALISATION_PREFIX.exec(content);
  if (!prefix) return null;
  const valueStart = prefix[0].length;
  for (let index = valueStart; index < content.length; index += 1) {
    if (content[index] !== '"') continue;
    // The closing delimiter is the first quote after which only whitespace or
    // an inline comment remains. This also consumes legacy values containing
    // unescaped inner quotes instead of leaving their tail in the document.
    if (!/^\s*(?:#.*)?$/u.test(content.slice(index + 1))) continue;
    return {
      key: prefix[2].trim(),
      text: content.slice(valueStart, index),
      valueStart,
      valueEnd: index,
    };
  }
  return null;
}

function escapeUnescapedQuotes(value) {
  let result = '';
  let consecutiveSlashes = 0;
  for (const character of value) {
    if (character === '\\') {
      consecutiveSlashes += 1;
      result += character;
      continue;
    }
    if (character === '"' && consecutiveSlashes % 2 === 0) result += '\\';
    result += character;
    consecutiveSlashes = 0;
  }
  return result;
}

function parseReplacementLine(raw) {
  const line = String(raw).trim();
  const colon = line.indexOf(':');
  if (colon < 1) return null;
  const key = line.slice(0, colon).trim();
  if (!/^[^\s:#"]+$/u.test(key)) return null;
  let remainder = line.slice(colon + 1).trimStart();
  const version = /^\d+/u.exec(remainder)?.[0] ?? '';
  if (version) remainder = remainder.slice(version.length).trimStart();
  if (remainder.length < 2 || !remainder.startsWith('"') || !remainder.endsWith('"')) return null;
  return { key, value: remainder.slice(1, -1) };
}

export function parseKeyReplacementBatch(source) {
  const entries = [];
  const errors = [];
  const duplicateKeys = new Set();
  const seen = new Set();
  const lines = String(source ?? '').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const parsed = parseReplacementLine(raw);
    if (!parsed) {
      errors.push({ line: index + 1, message: 'Ожидается запись вида key:0 "текст" или key: "текст".' });
      continue;
    }
    const key = parsed.key;
    const text = escapeUnescapedQuotes(parsed.value);
    const roundTrip = parseReplacementLine(`${key}:0 "${text}"`);
    if (!roundTrip || escapeUnescapedQuotes(roundTrip.value) !== text) {
      errors.push({ line: index + 1, message: 'Значение не удалось безопасно разобрать и собрать обратно.' });
      continue;
    }
    if (seen.has(key)) duplicateKeys.add(key);
    seen.add(key);
    entries.push({ key, text, line: index + 1 });
  }
  return { entries, errors, duplicateKeys: [...duplicateKeys] };
}

export function localisationEntries(text) {
  const result = [];
  let offset = 0;
  for (const line of String(text).split(/(?<=\n)/u)) {
    const ending = line.endsWith('\n') ? '\n' : '';
    const content = ending ? line.slice(0, -1).replace(/\r$/u, '') : line;
    const parsed = parseLocalisationSourceLine(content);
    if (parsed) {
      const valueStart = offset + parsed.valueStart;
      result.push({
        key: parsed.key, text: parsed.text, start: valueStart,
        end: offset + parsed.valueEnd,
      });
    }
    offset += line.length;
  }
  return result;
}

export function replaceLocalisationValues(text, replacements) {
  const wanted = replacements instanceof Map ? replacements : new Map(replacements);
  const matches = localisationEntries(text).filter((entry) => wanted.has(entry.key));
  let result = String(text);
  for (const match of matches.toReversed()) {
    result = `${result.slice(0, match.start)}${wanted.get(match.key)}${result.slice(match.end)}`;
  }
  return { text: result, matches };
}
