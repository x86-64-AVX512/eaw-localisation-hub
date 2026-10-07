export interface TechnicalInsertion {
  kind: 'reference' | 'getter' | 'variable' | 'scripted-gui' | 'conditional' | 'icon';
  name: string;
  formatter: string;
  start: number;
  end: number;
}

// Balanced dynamic expressions need their own grammar, not a flat ] regex.
export function dynamicExpressionEnd(text: string, start: number): number {
  let depth = 0, quote = '';
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === '\\') { cursor += 1; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '[') depth += 1;
    if (character === ']' && --depth === 0) return cursor;
  }
  return -1;
}

function insertion(kind: TechnicalInsertion['kind'], body: string, start: number, end: number): TechnicalInsertion {
  const separator = body.indexOf('|');
  return { kind, name: (separator < 0 ? body : body.slice(0, separator)).trim(),
    formatter: separator < 0 ? '' : body.slice(separator + 1), start, end };
}

function compactExpression(text: string): string {
  let result = '', quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') { result += character + (text[++index] ?? ''); continue; }
    if (quote) { result += character; if (character === quote) quote = ''; }
    else if (character === "'" || character === '"') { quote = character; result += character; }
    else if (!/\s/u.test(character)) result += character;
  }
  return result;
}

export function technicalInsertions(text: string): TechnicalInsertion[] {
  const tokens: TechnicalInsertion[] = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') { cursor += 1; continue; }
    if (text[cursor] === '$') {
      const end = text.indexOf('$', cursor + 1);
      if (end < 0) continue;
      const token = insertion('reference', text.slice(cursor + 1, end), cursor, end + 1);
      if (/^[\p{L}\p{N}_.:\-]+$/u.test(token.name)) tokens.push(token);
      cursor = end;
    } else if (text[cursor] === '[') {
      const end = dynamicExpressionEnd(text, cursor);
      if (end < 0) continue;
      const body = text.slice(cursor + 1, end);
      if (body.startsWith('(')) {
        tokens.push({ kind: 'conditional', name: compactExpression(body), formatter: '', start: cursor, end: end + 1 });
      } else if (/^(?:[?!]|Get\w*|[A-Za-z0-9_]+\.)/u.test(body)) {
        tokens.push(insertion(body[0] === '?' ? 'variable' : body[0] === '!' ? 'scripted-gui' : 'getter', body, cursor, end + 1));
      }
      cursor = end;
    } else if (text[cursor] === '£') {
      const dynamic = /^\$[^$\r\n]+\$£/u.exec(text.slice(cursor + 1));
      const literal = /^[\p{L}\p{N}_]+£?/u.exec(text.slice(cursor + 1));
      const body = dynamic?.[0] ?? literal?.[0];
      if (!body) continue;
      tokens.push({ kind: 'icon', name: body.replace(/£$/u, ''), formatter: '', start: cursor, end: cursor + body.length + 1 });
      cursor += body.length;
    }
  }
  return tokens;
}

export interface TechnicalDifference { kind: 'missing' | 'extra' | 'formatter'; token: string; detail: string }
export function compareTechnicalInsertions(russian: string, english: string,
  getterEquivalences: Readonly<Record<string, string>> = {}): TechnicalDifference[] {
  const group = (text: string) => {
    const result = new Map<string, TechnicalInsertion[]>();
    for (const token of technicalInsertions(text)) {
      const name = token.kind === 'getter' ? getterEquivalences[token.name] ?? token.name : token.name;
      const key = `${token.kind}:${name}`;
      const values = result.get(key) ?? []; values.push(token); result.set(key, values);
    }
    return result;
  };
  const ru = group(russian), en = group(english), issues: TechnicalDifference[] = [];
  for (const key of new Set([...en.keys(), ...ru.keys()])) {
    const left = ru.get(key) ?? [], right = en.get(key) ?? [];
    if (left.length !== right.length) issues.push({ kind: left.length < right.length ? 'missing' : 'extra',
      token: key, detail: `RU: ${left.length}; EN: ${right.length}` });
    else if (left.map((token) => token.formatter).sort().join('\0') !== right.map((token) => token.formatter).sort().join('\0')) {
      issues.push({ kind: 'formatter', token: key,
        detail: `RU: ${left.map((token) => token.formatter).join(', ')}; EN: ${right.map((token) => token.formatter).join(', ')}` });
    }
  }
  return issues;
}
