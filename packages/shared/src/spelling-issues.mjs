const WORD = /[А-ЯЁа-яё]{3,}(?:-[А-ЯЁа-яё]{2,})*/gu;

function quotedRanges(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return [];
  const first = line.indexOf('"', colon + 1); const last = line.lastIndexOf('"');
  return first >= 0 && last > first ? [{ start: first + 1, text: line.slice(first + 1, last) }] : [];
}

export function spellingIssues(text, checker, ignored = new Set(), { lineOffset = 0 } = {}) {
  const issues = [];
  for (const [lineIndex, line] of String(text).replaceAll('\r\n', '\n').split('\n').entries()) {
    if (line.trimStart().startsWith('#')) continue;
    for (const range of quotedRanges(line)) {
      for (const match of range.text.matchAll(WORD)) {
        const word = match[0]; const normal = word.toLocaleLowerCase('ru');
        if (ignored.has(normal) || checker.correct(word)) continue;
        issues.push({
          word, lineNumber: lineIndex + 1 + lineOffset, startColumn: range.start + match.index + 1,
          endColumn: range.start + match.index + word.length + 1,
        });
      }
    }
  }
  return issues;
}
