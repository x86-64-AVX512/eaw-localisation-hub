// Browser-safe key reader shared by Agent, server and Review. It must stay
// free of Node imports so every layer parses reservation ranges identically.
export function parseLocalisationKeys(text: string): Array<{ key: string; index: number }> {
  const entries: Array<{ key: string; index: number }> = [];
  const expression = /^[ \t]*([^#\s][^:\r\n]*):(?:\d+)?[ \t]+(?=\S)/gm;
  for (const match of text.matchAll(expression)) {
    entries.push({ key: match[1].trim(), index: match.index });
  }
  return entries;
}

export function keysInsideRange(text: string, startIndex: number, endIndex: number): string[] {
  return parseLocalisationKeys(text)
    .filter(({ index }) => index >= startIndex && index < endIndex)
    .map(({ key }) => key);
}
