import type { LocalisationDiagnostic } from './localisation-syntax.mts';
import type { LocalisationRecord } from './localisation-records.mts';
import { technicalInsertions } from './localisation-markup.mts';
import { diagnosticMessage } from './diagnostic-message.mts';
import type { DiagnosticMessage } from './diagnostic-message.mts';

// The documented set is intentionally NOT an exhaustive whitelist. Unknown
// getters only receive a likely-typo hint when there is a close known spelling.
function distance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 3;
  const rows = [Array.from({ length: right.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= left.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= right.length; j += 1) {
      row[j] = Math.min(row[j - 1] + 1, rows[i - 1][j] + 1,
        rows[i - 1][j - 1] + Number(left[i - 1] !== right[j - 1]));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
      }
    }
    rows.push(row);
  }
  return rows[left.length][right.length];
}

export function localisationSemanticDiagnostics(records: LocalisationRecord[], {
  knownGetters = null, knownParameters = null,
}: { knownGetters?: ReadonlySet<string> | null; knownParameters?: ReadonlySet<string> | null } = {}): LocalisationDiagnostic[] {
  const issues: LocalisationDiagnostic[] = [];
  const grouped = new Map<string, LocalisationRecord[]>();
  for (const record of records) {
    if (record.fault) continue;
    const list = grouped.get(record.key) ?? []; list.push(record); grouped.set(record.key, list);
  }
  const graph = new Map<string, string[]>();
  const suggestions = new Map<string, string | null>();
  const report = (record: LocalisationRecord, start: number, end: number,
    code: string, message: DiagnosticMessage, severity: LocalisationDiagnostic['severity'] = 'info') => issues.push({
      code, ...message, severity, lineNumber: record.lineNumber,
      startColumn: record.opening + start + 2, endColumn: record.opening + end + 2,
    });
  for (const [key, list] of grouped) {
    if (list.length !== 1) continue;
    const record = list[0], edges: string[] = [];
    for (const token of technicalInsertions(record.value)) {
      if (token.kind === 'reference' && !knownParameters?.has(token.name) && grouped.get(token.name)?.length === 1) edges.push(token.name);
      if (token.kind !== 'getter' || !knownGetters?.size) continue;
      const getter = token.name.split('.').at(-1)!;
      if (!getter.startsWith('Get') || knownGetters.has(getter)) continue;
      if (!suggestions.has(getter)) {
        let best = 3, matches: string[] = [];
        for (const name of knownGetters) {
          if (name[0] !== getter[0] || Math.abs(name.length - getter.length) > 2) continue;
          const score = distance(getter, name);
          if (score < best) { best = score; matches = [name]; }
          else if (score === best) matches.push(name);
        }
        suggestions.set(getter, best <= 2 && matches.length === 1 ? matches[0] : null);
      }
      const suggestion = suggestions.get(getter);
      if (suggestion) report(record, token.start, token.end, 'likely-getter-typo',
        diagnosticMessage('Возможная опечатка getter «{0}»: известно имя «{1}». Контекст выполнения не проверен.', getter, suggestion), 'warning');
    }
    graph.set(key, edges);
  }
  // Iterative DFS avoids overflowing the editor worker on a large file. Emit
  // one hint per back edge, not a diagnostic for every dependent declaration.
  const colours = new Map<string, number>();
  for (const root of graph.keys()) {
    if (colours.has(root)) continue;
    const stack = [{ key: root, next: 0 }]; colours.set(root, 1);
    while (stack.length) {
      const frame = stack.at(-1)!, edges = graph.get(frame.key) ?? [];
      if (frame.next >= edges.length) { colours.set(frame.key, 2); stack.pop(); continue; }
      const target = edges[frame.next++];
      if (colours.get(target) === 1) {
        const record = grouped.get(frame.key)![0];
        report(record, 0, record.value.length, 'local-reference-cycle',
          diagnosticMessage('Цикл ссылок между локальными ключами: «{0}» → «{1}». Runtime-параметры могут изменять раскрытие.', frame.key, target));
      } else if (!colours.has(target)) { colours.set(target, 1); stack.push({ key: target, next: 0 }); }
    }
  }
  return issues;
}
