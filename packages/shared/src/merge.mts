interface LineRecord {
  content: string;
  eol: string;
  key: string | null;
}

interface LinkedRecord extends LineRecord {
  previous: LinkedRecord | null;
  next: LinkedRecord | null;
}

interface Analysis {
  records: LineRecord[];
  lines: Map<string, string>;
  order: string[];
  duplicates: Set<string>;
  nonKeySignature: string;
}

export interface LocalisationConflict {
  key: string;
  label: string;
  baseLine: string | null;
  collaborativeLine: string | null;
  externalLine: string | null;
}

export type LocalisationVariant = Map<string, string | null>;

function declarationKey(content: string): string | null {
  // A draft may stop immediately after ':' or its version number. It still
  // belongs to that key: treating it as raw structure leaves an orphan line
  // when the local-file checkbox restores the complete Git declaration.
  // This is identity matching, not validation; syntax diagnostics stay strict.
  if (/^l_[a-z_]+:$/iu.test(content.trim())) return null;
  return /^[ \t]*([^#\s][^:\r\n]*):(?:\d+)?(?:[ \t]+|$)/u.exec(content)?.[1]?.trim() ?? null;
}

function splitLines(text: string): LineRecord[] {
  if (!text) return [];
  const records: LineRecord[] = [];
  let position = 0;
  while (position < text.length) {
    let end = text.indexOf('\n', position);
    if (end < 0) end = text.length;
    else end += 1;
    const raw = text.slice(position, end);
    const eol = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    const content = eol ? raw.slice(0, -eol.length) : raw;
    records.push({ content, eol, key: declarationKey(content) });
    position = end;
  }
  return records;
}

function structureSignature(records: LineRecord[], keys: ReadonlySet<string> | null = null): string {
  return JSON.stringify(records.filter(({ key }) => !key || !keys || keys.has(key))
    .map(({ key, content, eol }) => key ? ['key', key, Boolean(eol)] : ['text', content, Boolean(eol)]));
}

function analyse(text: string): Analysis {
  const records = splitLines(text);
  const lines = new Map<string, string>();
  const duplicates = new Set<string>();
  const order: string[] = [];
  for (const record of records) {
    if (!record.key) continue;
    if (lines.has(record.key)) duplicates.add(record.key);
    else order.push(record.key);
    lines.set(record.key, record.content);
  }
  return {
    records,
    lines,
    order,
    duplicates,
    nonKeySignature: structureSignature(records),
  };
}

function occurrenceAware(analysis: Analysis, duplicateKeys: ReadonlySet<string>): Analysis {
  if (!duplicateKeys.size) return analysis;
  const counts = new Map<string, number>();
  const records = analysis.records.map((record) => {
    if (!record.key || !duplicateKeys.has(record.key)) return record;
    const index = (counts.get(record.key) ?? 0) + 1;
    counts.set(record.key, index);
    return { ...record, key: `occ:${index}:${record.key}` };
  });
  const lines = new Map<string, string>();
  const order: string[] = [];
  for (const record of records) {
    if (!record.key) continue;
    lines.set(record.key, record.content);
    order.push(record.key);
  }
  return { records, lines, order, duplicates: new Set(), nonKeySignature: structureSignature(records) };
}

function allDuplicateKeys(...analyses: Analysis[]): Set<string> {
  return new Set(analyses.flatMap((analysis) => [...analysis.duplicates]));
}

function duplicateCount(analysis: Analysis, key: string): number {
  return analysis.records.reduce((count, record) => count + Number(record.key === key), 0);
}

function conflictLabel(key: string): string {
  const match = /^occ:([1-9]\d*):(.+)$/u.exec(key);
  return match ? `${match[2]} · вхождение ${match[1]}` : key;
}

function sameLine(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null);
}

function laterKeyExists(text: string, start: number, key: string): boolean {
  let index = text.indexOf(key, start);
  while (index >= 0) {
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    if (/^[ \t]*$/u.test(text.slice(lineStart, index)) && text[index + key.length] === ':') return true;
    index = text.indexOf(key, index + key.length);
  }
  return false;
}

function earlierKeyExists(text: string, end: number, key: string): boolean {
  let index = text.lastIndexOf(key, end - 1);
  while (index >= 0) {
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    if (/^[ \t]*$/u.test(text.slice(lineStart, index)) && text[index + key.length] === ':') return true;
    index = text.lastIndexOf(key, index - 1);
  }
  return false;
}

function singleLineVariant(previousText: string, currentText: string): LocalisationVariant | null {
  const shortest = Math.min(previousText.length, currentText.length);
  let start = 0;
  while (start < shortest && previousText[start] === currentText[start]) start += 1;
  if (start === previousText.length && start === currentText.length) return new Map();
  let previousEnd = previousText.length; let currentEnd = currentText.length;
  while (previousEnd > start && currentEnd > start
    && previousText[previousEnd - 1] === currentText[currentEnd - 1]) {
    previousEnd -= 1; currentEnd -= 1;
  }
  if (/[\r\n]/u.test(previousText.slice(start, previousEnd))
    || /[\r\n]/u.test(currentText.slice(start, currentEnd))) return null;
  const previousLineStart = previousText.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const currentLineStart = currentText.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let previousLineEnd = previousText.indexOf('\n', start);
  let currentLineEnd = currentText.indexOf('\n', start);
  previousLineEnd = previousLineEnd < 0 ? previousText.length : previousLineEnd + 1;
  currentLineEnd = currentLineEnd < 0 ? currentText.length : currentLineEnd + 1;
  if (previousLineStart !== currentLineStart
    || previousEnd > previousLineEnd || currentEnd > currentLineEnd) return null;
  const previousRaw = previousText.slice(previousLineStart, previousLineEnd);
  const currentRaw = currentText.slice(currentLineStart, currentLineEnd);
  const previousEol = previousRaw.endsWith('\n');
  const currentEol = currentRaw.endsWith('\n');
  const previousLine = previousRaw.replace(/\r?\n$/u, '');
  const currentLine = currentRaw.replace(/\r?\n$/u, '');
  const previousKey = declarationKey(previousLine);
  const currentKey = declarationKey(currentLine);
  if (!previousKey || previousKey !== currentKey || previousEol !== currentEol
    || earlierKeyExists(previousText, previousLineStart, previousKey)
    || earlierKeyExists(currentText, currentLineStart, currentKey)
    || laterKeyExists(previousText, previousLineEnd, previousKey)
    || laterKeyExists(currentText, currentLineEnd, currentKey)) return null;
  return previousLine === currentLine ? new Map() : new Map([[currentKey, currentLine]]);
}

function resolutionFor(resolutions: ReadonlyMap<string, string> | Record<string, string>, key: string): string | undefined {
  if (resolutions instanceof Map) return resolutions.get(key);
  return (resolutions as Record<string, string>)[key];
}

function lineEnding(records: LineRecord[]): string {
  return records.find(({ eol }) => eol)?.eol ?? '\r\n';
}

function renderWithChoices(templateText: string, choices: ReadonlyMap<string, string | null>,
  preferredOrder: string[], preserveKeys: ReadonlySet<string> = new Set(),
  duplicateKeys: ReadonlySet<string> = new Set()): string {
  const records = occurrenceAware(analyse(templateText), duplicateKeys).records;
  const eol = lineEnding(records);
  let first: LinkedRecord | null = null;
  let last: LinkedRecord | null = null;
  const firstByKey = new Map<string, LinkedRecord>();
  const insertBefore = (record: LineRecord, next: LinkedRecord | null, added = true): LinkedRecord => {
    const node: LinkedRecord = { ...record, previous: next ? next.previous : last, next };
    if (node.previous) node.previous.next = node;
    else first = node;
    if (next) next.previous = node;
    else last = node;
    if (added && node.previous && !node.previous.eol) node.previous.eol = eol;
    return node;
  };
  for (const record of records) {
    if (!record.key) {
      insertBefore(record, null, false);
      continue;
    }
    if (preserveKeys.has(record.key)) {
      const node = insertBefore(record, null, false);
      if (!firstByKey.has(record.key)) firstByKey.set(record.key, node);
      continue;
    }
    const chosen = choices.get(record.key);
    if (chosen == null) continue;
    const node = insertBefore({ content: chosen, eol: record.eol, key: record.key }, null, false);
    if (!firstByKey.has(record.key)) firstByKey.set(record.key, node);
  }

  // Future keys cannot be inserted before their turn, so the next available
  // anchor is always one of the original template keys. Resolve it once.
  const nextOriginal: Array<LinkedRecord | null> = new Array(preferredOrder.length);
  let following: LinkedRecord | null = null;
  for (let index = preferredOrder.length - 1; index >= 0; index -= 1) {
    nextOriginal[index] = following;
    following = firstByKey.get(preferredOrder[index]) ?? following;
  }
  let preceding: LinkedRecord | null = null;
  for (let index = 0; index < preferredOrder.length; index += 1) {
    const key = preferredOrder[index];
    const chosen = preserveKeys.has(key) ? null : choices.get(key);
    if (chosen == null) continue;
    const present = firstByKey.get(key);
    if (present) { preceding = present; continue; }
    const node = insertBefore({ content: chosen, eol, key },
      nextOriginal[index] ?? preceding?.next ?? null);
    firstByKey.set(key, node);
    preceding = node;
  }
  const rendered: string[] = [];
  for (let node = first as LinkedRecord | null; node; node = node.next) rendered.push(node.content + node.eol);
  return rendered.join('');
}

// An editor deletion can replace a keyed line with a blank line. If a later
// selection restores the key, that placeholder must not become an extra line
// in the local Git file. Restore the key's position relative to genuine blank
// lines as well, including when an earlier projection removed the placeholder.
// Only a proven single extra blank is removed; comments stay intact.
function removeRestoredKeyPlaceholder(gitText: string, templateText: string,
  projectedText: string, key: string): string {
  const git = analyse(gitText);
  const template = analyse(templateText);
  const projected = analyse(projectedText);
  if (git.duplicates.has(key) || template.duplicates.has(key) || projected.duplicates.has(key)
    || template.lines.has(key)) return projectedText;
  const keyIndex = git.records.findIndex((record) => record.key === key);
  if (keyIndex < 0) return projectedText;
  const anchorIndex = (candidate: string, records: LineRecord[]) => records.findIndex((record) => record.key === candidate);
  let before = '';
  let after = '';
  for (let index = keyIndex - 1; index >= 0; index -= 1) {
    const candidate = git.records[index].key;
    if (candidate && !git.duplicates.has(candidate) && !template.duplicates.has(candidate)
      && !projected.duplicates.has(candidate) && anchorIndex(candidate, template.records) >= 0
      && anchorIndex(candidate, projected.records) >= 0) { before = candidate; break; }
  }
  for (let index = keyIndex + 1; index < git.records.length; index += 1) {
    const candidate = git.records[index].key;
    if (candidate && !git.duplicates.has(candidate) && !template.duplicates.has(candidate)
      && !projected.duplicates.has(candidate) && anchorIndex(candidate, template.records) >= 0
      && anchorIndex(candidate, projected.records) >= 0) { after = candidate; break; }
  }
  const gap = (records: LineRecord[]) => {
    const start = before ? anchorIndex(before, records) : -1;
    const end = after ? anchorIndex(after, records) : records.length;
    return end > start ? records.slice(start + 1, end) : [];
  };
  const gitGap = gap(git.records);
  const templateGap = gap(template.records);
  const projectedGap = gap(projected.records);
  const gitNonKeys = gitGap.filter((record) => !record.key);
  const templateNonKeys = templateGap.filter((record) => !record.key);
  const projectedNonKeys = projectedGap.filter((record) => !record.key);
  const raw = (record: LineRecord) => record.content + record.eol;
  const sameRecord = (left: LineRecord, right: LineRecord) =>
    left.content === right.content && Boolean(left.eol) === Boolean(right.eol);
  const sameRecords = (left: LineRecord[], right: LineRecord[]) => left.length === right.length
    && left.every((record, index) => sameRecord(record, right[index]));
  const groupKeys = gitGap.filter((record) => record.key).map((record) => record.key!);
  const groupKeySet = new Set(groupKeys);
  // A deleted group can contain blank separators of its own. Anchor the whole
  // group before its untouched suffix (including comment headings), rather
  // than appending restored keys at the next keyed line after that suffix.
  // Only repair a proven deletion footprint: unchanged prefix/suffix, no new
  // keys, no ambiguous occurrences, and at most one blank editor placeholder.
  if (groupKeys.length && groupKeys.every((candidate) => !template.lines.has(candidate)
    && !git.duplicates.has(candidate) && !projected.duplicates.has(candidate))
    && templateGap.every((record) => !record.key)
    && projectedGap.every((record) => !record.key || groupKeySet.has(record.key))) {
    const firstKey = gitGap.findIndex((record) => record.key);
    const lastKey = gitGap.findLastIndex((record) => record.key);
    const prefix = gitGap.slice(0, firstKey);
    const suffix = gitGap.slice(lastKey + 1);
    const middle = templateGap.slice(prefix.length, templateGap.length - suffix.length);
    const untouchedEdges = templateGap.length >= prefix.length + suffix.length
      && sameRecords(templateGap.slice(0, prefix.length), prefix)
      && sameRecords(suffix.length ? templateGap.slice(-suffix.length) : [], suffix);
    const onlyDeletedSpacing = gitGap.slice(firstKey, lastKey + 1)
      .every((record) => record.key || !record.content.trim());
    if (untouchedEdges && onlyDeletedSpacing && middle.length <= 1
      && middle.every((record) => !record.content.trim())
      && (sameRecords(projectedNonKeys, templateNonKeys) || sameRecords(projectedNonKeys, gitNonKeys))) {
      const restored = new Map(projectedGap.filter((record) => record.key).map((record) => [record.key!, record]));
      const replacement = restored.size ? gitGap.flatMap((record) => {
        if (!record.key) return [record];
        const chosen = restored.get(record.key);
        return chosen ? [chosen] : [];
      }) : [...prefix, ...suffix];
      const start = before ? anchorIndex(before, projected.records) + 1 : 0;
      const end = after ? anchorIndex(after, projected.records) : projected.records.length;
      projected.records.splice(start, end - start, ...replacement);
      return projected.records.map(raw).join('');
    }
  }
  if (!projected.lines.has(key)) return projectedText;
  const spacingMatchesGit = projectedNonKeys.length === gitNonKeys.length
    && projectedNonKeys.every((record, index) => sameRecord(record, gitNonKeys[index]));
  let extraIndex = -1;
  if (!spacingMatchesGit) {
    if (templateNonKeys.length !== gitNonKeys.length + 1
      || projectedNonKeys.length !== templateNonKeys.length
      || !projectedNonKeys.every((record, index) => sameRecord(record, templateNonKeys[index]))) return projectedText;
    extraIndex = templateNonKeys.findIndex((record, index) =>
      !record.content.trim() && templateNonKeys.filter((_, other) => other !== index)
        .every((other, position) => sameRecord(other, gitNonKeys[position])));
    if (extraIndex < 0) return projectedText;
  }
  const projectedStart = before ? anchorIndex(before, projected.records) + 1 : 0;
  let seen = 0;
  for (let index = projectedStart; extraIndex >= 0 && index < projected.records.length; index += 1) {
    if (projected.records[index].key) continue;
    if (seen++ !== extraIndex) continue;
    projected.records.splice(index, 1);
    break;
  }
  // Once a deletion has been projected, its placeholder may already be gone.
  // The restored key still belongs before/after Git's existing blank lines,
  // rather than wherever the next keyed anchor happened to insert it.
  const restoredIndex = projected.records.findIndex((record) => record.key === key);
  if (restoredIndex < 0) return projectedText;
  const [restored] = projected.records.splice(restoredIndex, 1);
  const gitKeyIndex = gitGap.findIndex((record) => record.key === key);
  const projectedBefore = before ? anchorIndex(before, projected.records) : -1;
  const projectedEnd = after ? anchorIndex(after, projected.records) : projected.records.length;
  const nonKeyPositions = projected.records.map((record, position) =>
    position > projectedBefore && position < projectedEnd && !record.key ? position : -1)
    .filter((position) => position >= 0);
  let insertionIndex = projectedBefore;
  let nonKeyOrdinal = 0;
  const keyOrdinals = new Map<string, number>();
  for (const record of gitGap.slice(0, gitKeyIndex)) {
    if (record.key) {
      const ordinal = keyOrdinals.get(record.key) ?? 0;
      keyOrdinals.set(record.key, ordinal + 1);
      const found = projected.records.map((candidate, position) =>
        position > projectedBefore && position < projectedEnd && candidate.key === record.key ? position : -1)
        .filter((position) => position >= 0)[ordinal];
      if (found !== undefined) insertionIndex = Math.max(insertionIndex, found);
    } else {
      const found = nonKeyPositions[nonKeyOrdinal++];
      if (found !== undefined) insertionIndex = Math.max(insertionIndex, found);
    }
  }
  projected.records.splice(insertionIndex + 1, 0, restored);
  return projected.records.map(raw).join('');
}

export function mergeLocalisationThreeWay(baseText: string, collaborativeText: string, externalText: string,
  resolutions: ReadonlyMap<string, string> | Record<string, string> = {}) {
  if (collaborativeText === externalText) {
    return { text: collaborativeText, conflicts: [], changed: false };
  }

  const baseRaw = analyse(baseText);
  const collaborativeRaw = analyse(collaborativeText);
  const externalRaw = analyse(externalText);
  const conflicts: LocalisationConflict[] = [];
  const duplicateKeys = allDuplicateKeys(baseRaw, collaborativeRaw, externalRaw);
  if ([...duplicateKeys].some((key) => duplicateCount(baseRaw, key) !== duplicateCount(collaborativeRaw, key)
    || duplicateCount(baseRaw, key) !== duplicateCount(externalRaw, key))) {
    const duplicateResolution = resolutionFor(resolutions, '__duplicate_keys__');
    if (duplicateResolution === 'external') {
      return { text: externalText, conflicts: [], changed: externalText !== collaborativeText };
    }
    if (duplicateResolution === 'collaborative') {
      return { text: collaborativeText, conflicts: [], changed: false };
    }
    conflicts.push({
      key: '__duplicate_keys__',
      label: `Изменилось количество вхождений ключей: ${[...duplicateKeys].join(', ')}`,
      baseLine: null,
      collaborativeLine: null,
      externalLine: null,
    });
  }

  const base = occurrenceAware(baseRaw, duplicateKeys);
  const collaborative = occurrenceAware(collaborativeRaw, duplicateKeys);
  const external = occurrenceAware(externalRaw, duplicateKeys);

  // Additions/deletions are merged per key. Compare layout around the surviving
  // anchors so independent new keys do not create spurious structure conflicts.
  const commonKeys = new Set(base.order.filter((key) => collaborative.lines.has(key) && external.lines.has(key)));
  const baseStructure = structureSignature(base.records, commonKeys);
  const collaborativeStructure = structureSignature(collaborative.records, commonKeys);
  const externalStructure = structureSignature(external.records, commonKeys);
  const collaborativeStructureChanged = collaborativeStructure !== baseStructure;
  const externalStructureChanged = externalStructure !== baseStructure;
  let templateText = collaborativeText;
  if (externalStructureChanged && !collaborativeStructureChanged) {
    templateText = externalText;
  } else if (
    externalStructureChanged
    && collaborativeStructureChanged
    && externalStructure !== collaborativeStructure
  ) {
    const structureResolution = resolutionFor(resolutions, '__file_structure__');
    if (structureResolution === 'external') templateText = externalText;
    else if (!structureResolution) {
      conflicts.push({
        key: '__file_structure__',
        label: 'Структура файла и комментарии',
        baseLine: null,
        collaborativeLine: null,
        externalLine: null,
      });
    }
  }

  const allKeys = new Set([
    ...base.lines.keys(),
    ...collaborative.lines.keys(),
    ...external.lines.keys(),
  ]);
  const choices = new Map<string, string | null>();
  for (const key of allKeys) {
    const baseLine = base.lines.get(key) ?? null;
    const collaborativeLine = collaborative.lines.get(key) ?? null;
    const externalLine = external.lines.get(key) ?? null;
    const collaborativeChanged = !sameLine(collaborativeLine, baseLine);
    const externalChanged = !sameLine(externalLine, baseLine);
    let chosen = collaborativeLine;
    if (!collaborativeChanged && externalChanged) chosen = externalLine;
    else if (collaborativeChanged && !externalChanged) chosen = collaborativeLine;
    else if (collaborativeChanged && externalChanged && !sameLine(collaborativeLine, externalLine)) {
      const resolution = resolutionFor(resolutions, key);
      if (resolution === 'external') chosen = externalLine;
      else if (resolution === 'collaborative') chosen = collaborativeLine;
      else {
        conflicts.push({
          key,
          label: conflictLabel(key),
          baseLine,
          collaborativeLine,
          externalLine,
        });
      }
    }
    choices.set(key, chosen);
  }

  const preferredOrder = [...external.order, ...collaborative.order.filter((key) => !external.lines.has(key))];
  const text = renderWithChoices(templateText, choices, preferredOrder, new Set(), duplicateKeys);
  return { text, conflicts, changed: text !== collaborativeText };
}

export function localisationChangedKeys(previousText: string, currentText: string): Set<string> {
  const previousRaw = analyse(previousText);
  const currentRaw = analyse(currentText);
  const duplicateKeys = allDuplicateKeys(previousRaw, currentRaw);
  const previous = occurrenceAware(previousRaw, duplicateKeys);
  const current = occurrenceAware(currentRaw, duplicateKeys);
  const changed = new Set<string>();
  for (const key of new Set([...previous.lines.keys(), ...current.lines.keys()])) {
    if (!sameLine(previous.lines.get(key), current.lines.get(key))) changed.add(key);
  }
  if (previous.nonKeySignature !== current.nonKeySignature) changed.add('__file_structure__');
  return changed;
}

export function captureLocalisationVariant(previousText: string, currentText: string): LocalisationVariant {
  const local = singleLineVariant(previousText, currentText);
  if (local) return local;
  const previousRaw = analyse(previousText);
  const currentRaw = analyse(currentText);
  const duplicateKeys = allDuplicateKeys(previousRaw, currentRaw);
  const previous = occurrenceAware(previousRaw, duplicateKeys);
  const current = occurrenceAware(currentRaw, duplicateKeys);
  const changed = new Map<string, string | null>();
  for (const key of new Set([...previous.lines.keys(), ...current.lines.keys()])) {
    if (!sameLine(previous.lines.get(key), current.lines.get(key))) {
      changed.set(key, current.lines.get(key) ?? null);
    }
  }
  if (previous.nonKeySignature !== current.nonKeySignature) {
    changed.set('__file_structure__', currentText);
  }
  return changed;
}

function sourceKey(key: string): string {
  return /^occ:[1-9]\d*:(.+)$/u.exec(key)?.[1] ?? key;
}

// A delta uses the occurrence shape of the two edited snapshots; an accumulated
// variant must instead use the shape of Git and the resulting file. Migrate the
// whole affected group when its count changes, while retaining unrelated edits.
export function accumulateLocalisationVariant(gitText: string, variant: ReadonlyMap<string, string | null>,
  previousText: string, currentText: string, changes = captureLocalisationVariant(previousText, currentText)): LocalisationVariant {
  const next = new Map(variant);
  const touched = new Set([...changes.keys()].filter((key) => key !== '__file_structure__').map(sourceKey));
  const occurrenceChange = [...changes.keys(), ...variant.keys()].some((key) => key.startsWith('occ:'));
  const git = analyse(gitText);
  if (!changes.has('__file_structure__') && !occurrenceChange
    && ![...touched].some((key) => git.duplicates.has(key))) {
    for (const [key, line] of changes) next.set(key, line);
    return next;
  }
  const current = analyse(currentText);
  const duplicateKeys = allDuplicateKeys(git, current);
  for (const key of touched) {
    if (duplicateKeys.has(key)) {
      if (next.has(key)) {
        if (!next.has(`occ:1:${key}`)) next.set(`occ:1:${key}`, next.get(key)!);
        next.delete(key);
      }
    } else {
      if (!next.has(key) && next.has(`occ:1:${key}`)) next.set(key, next.get(`occ:1:${key}`)!);
      for (const stored of next.keys()) if (stored !== key && sourceKey(stored) === key) next.delete(stored);
    }
    for (const [changed, line] of changes) {
      if (sourceKey(changed) !== key) continue;
      // A removed second occurrence must not overwrite the surviving first one
      // when the group becomes unique again. Apply only this actor's delta,
      // never the whole current group (which can contain another author's edit).
      if (!duplicateKeys.has(key) && /^occ:(?:[2-9]|[1-9]\d+):/u.test(changed)) continue;
      const id = duplicateKeys.has(key) ? (changed === key ? `occ:1:${key}` : changed) : key;
      next.set(id, line);
    }
  }
  if (changes.has('__file_structure__')) next.set('__file_structure__', changes.get('__file_structure__')!);
  return next;
}

export function projectLocalisationVariant(gitText: string, variant: ReadonlyMap<string, string | null> | null): string {
  const gitRaw = analyse(gitText);
  const structure = variant?.get('__file_structure__');
  const template = typeof structure === 'string' ? structure : gitText;
  const templateRaw = typeof structure === 'string' ? analyse(structure) : gitRaw;
  const duplicateKeys = allDuplicateKeys(gitRaw, templateRaw);
  for (const key of variant?.keys() ?? []) {
    const match = /^occ:[1-9]\d*:(.+)$/u.exec(key);
    if (match) duplicateKeys.add(match[1]);
  }
  const git = occurrenceAware(gitRaw, duplicateKeys);
  const choices = new Map<string, string | null>(git.lines);
  for (const [key, line] of variant ?? []) {
    if (key === '__file_structure__') continue;
    // Schema-5 maps can contain both a bare key and occurrence IDs. Prefer the
    // explicit occurrence and never append the obsolete bare declaration.
    if (duplicateKeys.has(key)) {
      if (!variant?.has(`occ:1:${key}`)) choices.set(`occ:1:${key}`, line);
    } else choices.set(key, line);
  }
  const variantText = typeof structure === 'string' ? occurrenceAware(templateRaw, duplicateKeys) : null;
  const order = [
    ...git.order,
    ...(variantText?.order ?? []).filter((key) => !git.lines.has(key)),
    ...[...(variant?.keys?.() ?? [])].filter((key) => key !== '__file_structure__' && !git.lines.has(key)),
  ];
  let projected = renderWithChoices(template, choices, [...new Set(order)], new Set(), duplicateKeys);
  for (const key of gitRaw.order) {
    if (!templateRaw.lines.has(key) && choices.get(key) != null) {
      projected = removeRestoredKeyPlaceholder(gitText, template, projected, key);
    }
  }
  return projected;
}

export function localisationVariantConflicts(gitText: string,
  variants: Iterable<[string, ReadonlyMap<string, string | null>]> | null,
  ownerNames: ReadonlyMap<string, string> = new Map()) {
  const variantEntries = [...(variants ?? [])];
  const gitRaw = analyse(gitText);
  const duplicateKeys = new Set(gitRaw.duplicates);
  for (const [, variant] of variantEntries) {
    for (const key of variant.keys()) {
      const match = /^occ:[1-9]\d*:(.+)$/u.exec(key);
      if (match) duplicateKeys.add(match[1]);
    }
  }
  const git = occurrenceAware(gitRaw, duplicateKeys);
  const byKey = new Map<string, Array<{ authorId: string; author: string; line: string | null }>>();
  for (const [authorId, variant] of variantEntries) {
    for (const [stored, line] of variant) {
      if (stored === '__file_structure__') continue;
      const key = duplicateKeys.has(stored) ? `occ:1:${stored}` : stored;
      if (key !== stored && variant.has(key)) continue;
      if (sameLine(line, git.lines.get(key) ?? null)) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push({ authorId, author: ownerNames.get(authorId) ?? 'Unknown', line });
    }
  }
  return [...byKey]
    .filter(([, items]) => new Set(items.map((item) => item.line)).size > 1)
    .map(([key, items]) => ({ key, baseLine: git.lines.get(key) ?? null, variants: items }));
}

export function projectLocalisationOwnership(gitText: string, currentText: string,
  ownership: ReadonlyMap<string, string>, userId: string): string {
  const gitRaw = analyse(gitText);
  const currentRaw = analyse(currentText);
  const duplicateKeys = allDuplicateKeys(gitRaw, currentRaw);
  const git = occurrenceAware(gitRaw, duplicateKeys);
  const current = occurrenceAware(currentRaw, duplicateKeys);
  const choices = new Map<string, string | null>();
  for (const key of new Set([...git.lines.keys(), ...current.lines.keys()])) {
    choices.set(key, ownership.get(key) === userId
      ? (current.lines.get(key) ?? null)
      : (git.lines.get(key) ?? null));
  }
  const template = ownership.get('__file_structure__') === userId ? currentText : gitText;
  const order = [...git.order, ...current.order.filter((key) => !git.lines.has(key))];
  return renderWithChoices(template, choices, order, new Set(), duplicateKeys);
}

function keyedRecords(analysis: Analysis): Map<string, { line: string; lineNumber: number }> {
  const result = new Map<string, { line: string; lineNumber: number }>();
  analysis.records.forEach((record, index) => {
    if (record.key && !result.has(record.key)) {
      result.set(record.key, { line: record.content, lineNumber: index + 1 });
    }
  });
  return result;
}

function occurrences(analysis: Analysis): Map<string, Array<{ line: string; lineNumber: number }>> {
  const result = new Map<string, Array<{ line: string; lineNumber: number }>>();
  analysis.records.forEach((record, index) => {
    if (!record.key) return;
    if (!result.has(record.key)) result.set(record.key, []);
    result.get(record.key)!.push({ line: record.content, lineNumber: index + 1 });
  });
  return result;
}

function occurrenceId(key: string, index: number): string {
  return `occ:${index + 1}:${key}`;
}

export function localisationHasDuplicateKeys(...texts: string[]): boolean {
  return texts.some((value) => analyse(value).duplicates.size > 0);
}

export function localisationSelectionChanges(gitText: string, sharedText: string, localText: string) {
  const git = analyse(gitText);
  const shared = analyse(sharedText);
  const local = analyse(localText);
  const duplicateKeys = [...new Set([...git.duplicates, ...shared.duplicates, ...local.duplicates])];
  const gitRecords = keyedRecords(git);
  const sharedRecords = keyedRecords(shared);
  const localRecords = keyedRecords(local);
  const gitOccurrences = occurrences(git);
  const sharedOccurrences = occurrences(shared);
  const localOccurrences = occurrences(local);
  const structuralKeys = new Set(git.order.filter((key) => shared.lines.has(key)));
  const gitStructure = structureSignature(git.records, structuralKeys);
  const sharedStructure = structureSignature(shared.records, structuralKeys);
  const localStructure = structureSignature(local.records, structuralKeys);
  const maximumLine = Math.max(1, shared.records.length);
  const entries = [];
  const ambiguousKeys: string[] = [];
  for (const key of new Set([...git.lines.keys(), ...shared.lines.keys(), ...local.lines.keys()])) {
    if (duplicateKeys.includes(key)) {
      const gitItems = gitOccurrences.get(key) ?? [];
      const sharedItems = sharedOccurrences.get(key) ?? [];
      const localItems = localOccurrences.get(key) ?? [];
      if (gitItems.length !== sharedItems.length || gitItems.length !== localItems.length) {
        ambiguousKeys.push(key);
        continue;
      }
      for (let index = 0; index < gitItems.length; index += 1) {
        const gitLine = gitItems[index].line;
        const sharedLine = sharedItems[index].line;
        const localLine = localItems[index].line;
        if (sameLine(gitLine, sharedLine) && sameLine(localLine, gitLine)) continue;
        entries.push({
          id: occurrenceId(key, index), key,
          label: `${key} · вхождение ${index + 1}/${gitItems.length}`,
          lineNumber: Math.max(1, Math.min(maximumLine, sharedItems[index].lineNumber)),
          gitLine, sharedLine, localLine,
          state: sameLine(localLine, sharedLine) ? 'included'
            : sameLine(localLine, gitLine) ? 'excluded' : 'custom',
          kind: sameLine(gitLine, sharedLine) ? 'local-only' : 'modified',
        });
      }
      continue;
    }
    const gitLine = git.lines.get(key) ?? null;
    const sharedLine = shared.lines.get(key) ?? null;
    const localLine = local.lines.get(key) ?? null;
    if (sameLine(gitLine, sharedLine) && sameLine(localLine, gitLine)) continue;
    const state = sameLine(localLine, sharedLine)
      ? 'included' : sameLine(localLine, gitLine) ? 'excluded' : 'custom';
    const sourceLine = sharedRecords.get(key)?.lineNumber ?? gitRecords.get(key)?.lineNumber ?? 1;
    entries.push({
      id: `key:${key}`,
      key,
      label: key,
      lineNumber: Math.max(1, Math.min(maximumLine, sourceLine)),
      gitLine,
      sharedLine,
      localLine: localRecords.get(key)?.line ?? localLine,
      state,
      kind: sameLine(gitLine, sharedLine) ? 'local-only'
        : gitLine == null ? 'added' : sharedLine == null ? 'deleted' : 'modified',
    });
  }
  entries.sort((left, right) => left.lineNumber - right.lineNumber);
  const duplicateCountsMatch = duplicateKeys.every((key) => duplicateCount(git, key) === duplicateCount(shared, key)
    && duplicateCount(git, key) === duplicateCount(local, key));
  const localOnlyStructure = gitStructure === sharedStructure && localStructure !== gitStructure;
  if ((duplicateKeys.length === 0 && (gitStructure !== sharedStructure || localOnlyStructure))
    || (localOnlyStructure && duplicateCountsMatch)) {
    entries.unshift({
      id: '__file_structure__',
      key: '__file_structure__',
      label: 'Структура файла и отдельные комментарии',
      lineNumber: 1,
      gitLine: null,
      sharedLine: null,
      localLine: null,
      state: localOnlyStructure ? 'custom' : localStructure === sharedStructure
        ? 'included' : localStructure === gitStructure ? 'excluded' : 'custom',
      kind: 'structure',
    });
  }
  return {
    entries,
    blockedReason: ambiguousKeys.length
      ? `Нельзя сопоставить вхождения ключей с разным количеством повторов: ${ambiguousKeys.join(', ')}. Остальные изменения доступны.`
      : duplicateKeys.length && gitStructure !== sharedStructure
        ? 'Структуру файла с повторяющимися ключами нельзя выбрать построчно; изменения ключей доступны.'
        : '',
  };
}

export function setLocalisationSelection(gitText: string, sharedText: string, localText: string,
  changeId: string, include: boolean): string {
  const git = analyse(gitText);
  const shared = analyse(sharedText);
  const local = analyse(localText);
  const duplicateKeys = new Set([...git.duplicates, ...shared.duplicates, ...local.duplicates]);
  if (String(changeId).startsWith('occ:')) {
    const match = /^occ:([1-9]\d*):(.+)$/u.exec(changeId);
    if (!match) throw new Error('Unknown local-file occurrence');
    const index = Number(match[1]) - 1;
    const key = match[2];
    if (!duplicateKeys.has(key)) throw new Error('The selected localisation key is not repeated');
    const gitItems = occurrences(git).get(key) ?? [];
    const sharedItems = occurrences(shared).get(key) ?? [];
    const localItems = occurrences(local).get(key) ?? [];
    if (gitItems.length !== sharedItems.length || gitItems.length !== localItems.length
      || index >= gitItems.length) throw new Error('Local-file occurrences cannot be matched');
    if (sameLine(gitItems[index].line, sharedItems[index].line)
      && sameLine(localItems[index].line, gitItems[index].line)) {
      throw new Error('The shared change is no longer current');
    }
    const records = local.records;
    const position = localItems[index].lineNumber - 1;
    records[position].content = include ? sharedItems[index].line : gitItems[index].line;
    return records.map(({ content, eol }) => content + eol).join('');
  }
  if (changeId === '__file_structure__') {
    const structuralKeys = new Set(git.order.filter((key) => shared.lines.has(key)));
    const gitStructure = structureSignature(git.records, structuralKeys);
    const sharedStructure = structureSignature(shared.records, structuralKeys);
    const localStructure = structureSignature(local.records, structuralKeys);
    if (gitStructure === sharedStructure) {
      if (localStructure === gitStructure) throw new Error('The local structure already matches Git');
      if ([...duplicateKeys].some((key) => duplicateCount(git, key) !== duplicateCount(shared, key)
        || duplicateCount(git, key) !== duplicateCount(local, key))) {
        throw new Error('File structure is ambiguous because a localisation key is repeated');
      }
      const variant = captureLocalisationVariant(gitText, localText);
      variant.delete(changeId);
      return projectLocalisationVariant(gitText, variant);
    }
    if (duplicateKeys.size) throw new Error('File structure is ambiguous because a localisation key is repeated');
    const variant = captureLocalisationVariant(gitText, localText);
    if (include) variant.set(changeId, sharedText);
    else variant.delete(changeId);
    return projectLocalisationVariant(gitText, variant);
  }
  if (!String(changeId).startsWith('key:')) throw new Error('Unknown local-file change');
  const key = String(changeId).slice(4);
  if (duplicateKeys.has(key)) throw new Error('The selected localisation key is repeated');
  if (sameLine(git.lines.get(key) ?? null, shared.lines.get(key) ?? null)
    && sameLine(local.lines.get(key) ?? null, git.lines.get(key) ?? null)) {
    throw new Error('The shared change is no longer current');
  }
  const choices = new Map<string, string | null>(local.lines);
  choices.set(key, include ? (shared.lines.get(key) ?? null) : (git.lines.get(key) ?? null));
  const preferred = include
    ? [...shared.order, ...git.order.filter((candidate) => !shared.lines.has(candidate))]
    : [...git.order, ...shared.order.filter((candidate) => !git.lines.has(candidate))];
  preferred.push(...local.order.filter((candidate) => !preferred.includes(candidate)));
  const projected = renderWithChoices(localText, choices, [...new Set(preferred)], duplicateKeys);
  return git.lines.has(key) && !shared.lines.has(key)
    ? removeRestoredKeyPlaceholder(gitText, sharedText, projected, key) : projected;
}
