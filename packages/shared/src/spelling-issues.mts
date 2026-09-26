const WORD = /[А-ЯЁа-яё]{3,}(?:-[А-ЯЁа-яё]{2,})*/gu;

export interface SpellingIssue {
  word: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
}

function quotedRanges(line: string): Array<{ start: number; text: string }> {
  const colon = line.indexOf(':');
  if (colon < 0) return [];
  const first = line.indexOf('"', colon + 1); const last = line.lastIndexOf('"');
  return first >= 0 && last > first ? [{ start: first + 1, text: line.slice(first + 1, last) }] : [];
}

export function spellingIssues(text: unknown, checker: { correct(word: string): boolean },
  ignored: ReadonlySet<string> = new Set(), { lineOffset = 0 }: { lineOffset?: number } = {}): SpellingIssue[] {
  const issues: SpellingIssue[] = [];
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
