const INPUT_LINE = /^\s*([^\s:#"]+)\s*:(?:\d+)?\s+"((?:[^"\\]|\\.)*)"\s*$/u;
const LOCALISATION_LINE = /^(\s*)([^#\s][^:]*?)(:\d+)(\s+")((?:[^"\\]|\\.)*)(".*)$/u;

export function parseKeyReplacementBatch(source) {
  const entries = [];
  const errors = [];
  const duplicateKeys = new Set();
  const seen = new Set();
  const lines = String(source ?? '').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    const match = INPUT_LINE.exec(raw);
    if (!match) {
      errors.push({ line: index + 1, message: 'Ожидается запись вида key:0 "текст" или key: "текст".' });
      continue;
    }
    const key = match[1];
    if (seen.has(key)) duplicateKeys.add(key);
    seen.add(key);
    entries.push({ key, text: match[2], line: index + 1 });
  }
  return { entries, errors, duplicateKeys: [...duplicateKeys] };
}

export function localisationEntries(text) {
  const result = [];
  let offset = 0;
  for (const line of String(text).split(/(?<=\n)/u)) {
    const ending = line.endsWith('\n') ? '\n' : '';
    const content = ending ? line.slice(0, -1).replace(/\r$/u, '') : line;
    const match = LOCALISATION_LINE.exec(content);
    if (match) {
      const valueStart = offset + match[1].length + match[2].length
        + match[3].length + match[4].length;
      result.push({
        key: match[2].trim(), text: match[5], start: valueStart,
        end: valueStart + match[5].length,
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
