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
    const match = /^[ \t]*([^#\s][^:\r\n]*):(?:\d+)?[ \t]+/.exec(content);
    records.push({ content, eol, key: match ? match[1].trim() : null });
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
  const expression = /^[ \t]*([^#\s][^:\r\n]*):(?:\d+)?[ \t]+/u;
  const previousKey = expression.exec(previousLine)?.[1]?.trim();
  const currentKey = expression.exec(currentLine)?.[1]?.trim();
  if (!previousKey || previousKey !== currentKey || previousEol !== currentEol
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
  preferredOrder: string[]): string {
  const records = splitLines(templateText);
  const eol = lineEnding(records);
  let first: LinkedRecord | null = null;
  let last: LinkedRecord | null = null;
  const firstByKey = new Map<string, LinkedRecord>();
  const insertBefore = (record: LineRecord, next: LinkedRecord | null, added = true): LinkedRecord => {
    const node: LinkedRecord = { ...record, previous: next?.previous ?? last, next };
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
    const chosen = choices.get(key);
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

export function mergeLocalisationThreeWay(baseText: string, collaborativeText: string, externalText: string,
  resolutions: ReadonlyMap<string, string> | Record<string, string> = {}) {
  if (collaborativeText === externalText) {
    return { text: collaborativeText, conflicts: [], changed: false };
  }

  const base = analyse(baseText);
  const collaborative = analyse(collaborativeText);
  const external = analyse(externalText);
  const conflicts: LocalisationConflict[] = [];
  const duplicateKeys = new Set([
    ...base.duplicates,
    ...collaborative.duplicates,
    ...external.duplicates,
  ]);
  if (duplicateKeys.size > 0) {
    const duplicateResolution = resolutionFor(resolutions, '__duplicate_keys__');
    if (duplicateResolution === 'external') {
      return { text: externalText, conflicts: [], changed: externalText !== collaborativeText };
    }
    if (duplicateResolution === 'collaborative') {
      return { text: collaborativeText, conflicts: [], changed: false };
    }
    conflicts.push({
      key: '__duplicate_keys__',
      label: `Повторяющиеся ключи: ${[...duplicateKeys].join(', ')}`,
      baseLine: null,
      collaborativeLine: null,
      externalLine: null,
    });
  }

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
          label: key,
          baseLine,
          collaborativeLine,
          externalLine,
        });
      }
    }
    choices.set(key, chosen);
  }

  const preferredOrder = [...external.order, ...collaborative.order.filter((key) => !external.lines.has(key))];
  const text = renderWithChoices(templateText, choices, preferredOrder);
  return { text, conflicts, changed: text !== collaborativeText };
}

export function localisationChangedKeys(previousText: string, currentText: string): Set<string> {
  const previous = analyse(previousText);
  const current = analyse(currentText);
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
  const previous = analyse(previousText);
  const current = analyse(currentText);
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

export function projectLocalisationVariant(gitText: string, variant: ReadonlyMap<string, string | null> | null): string {
  const git = analyse(gitText);
  if (git.duplicates.size) return gitText;
  const choices = new Map<string, string | null>(git.lines);
  for (const [key, line] of variant ?? []) {
    if (key !== '__file_structure__') choices.set(key, line);
  }
  const structure = variant?.get('__file_structure__');
  const template = typeof structure === 'string' ? structure : gitText;
  const variantText = typeof structure === 'string' ? analyse(structure) : null;
  const order = [
    ...git.order,
    ...(variantText?.order ?? []).filter((key) => !git.lines.has(key)),
    ...[...(variant?.keys?.() ?? [])].filter((key) => key !== '__file_structure__' && !git.lines.has(key)),
  ];
  return renderWithChoices(template, choices, [...new Set(order)]);
}

export function localisationVariantConflicts(gitText: string,
  variants: Iterable<[string, ReadonlyMap<string, string | null>]> | null,
  ownerNames: ReadonlyMap<string, string> = new Map()) {
  const git = analyse(gitText);
  const byKey = new Map<string, Array<{ authorId: string; author: string; line: string | null }>>();
  for (const [authorId, variant] of variants ?? []) {
    for (const [key, line] of variant) {
      if (key === '__file_structure__') continue;
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
  const git = analyse(gitText);
  const current = analyse(currentText);
  if (git.duplicates.size || current.duplicates.size) return gitText;
  const choices = new Map<string, string | null>();
  for (const key of new Set([...git.lines.keys(), ...current.lines.keys()])) {
    choices.set(key, ownership.get(key) === userId
      ? (current.lines.get(key) ?? null)
      : (git.lines.get(key) ?? null));
  }
  const template = ownership.get('__file_structure__') === userId ? currentText : gitText;
  const order = [...git.order, ...current.order.filter((key) => !git.lines.has(key))];
  return renderWithChoices(template, choices, order);
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

export function localisationSelectionChanges(gitText: string, sharedText: string, localText: string) {
  const git = analyse(gitText);
  const shared = analyse(sharedText);
  const local = analyse(localText);
  const duplicateKeys = [...new Set([...git.duplicates, ...shared.duplicates, ...local.duplicates])];
  if (duplicateKeys.length) {
    return {
      entries: [],
      blockedReason: `Нельзя выбрать изменения построчно: повторяющиеся ключи – ${duplicateKeys.join(', ')}.`,
    };
  }
  const gitRecords = keyedRecords(git);
  const sharedRecords = keyedRecords(shared);
  const localRecords = keyedRecords(local);
  const structuralKeys = new Set(git.order.filter((key) => shared.lines.has(key)));
  const gitStructure = structureSignature(git.records, structuralKeys);
  const sharedStructure = structureSignature(shared.records, structuralKeys);
  const localStructure = structureSignature(local.records, structuralKeys);
  const maximumLine = Math.max(1, shared.records.length);
  const entries = [];
  for (const key of new Set([...git.lines.keys(), ...shared.lines.keys()])) {
    const gitLine = git.lines.get(key) ?? null;
    const sharedLine = shared.lines.get(key) ?? null;
    if (sameLine(gitLine, sharedLine)) continue;
    const localLine = local.lines.get(key) ?? null;
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
      kind: gitLine == null ? 'added' : sharedLine == null ? 'deleted' : 'modified',
    });
  }
  if (gitStructure !== sharedStructure) {
    entries.unshift({
      id: '__file_structure__',
      key: '__file_structure__',
      label: 'Структура файла и отдельные комментарии',
      lineNumber: 1,
      gitLine: null,
      sharedLine: null,
      localLine: null,
      state: localStructure === sharedStructure
        ? 'included' : localStructure === gitStructure ? 'excluded' : 'custom',
      kind: 'structure',
    });
  }
  return { entries, blockedReason: '' };
}

export function setLocalisationSelection(gitText: string, sharedText: string, localText: string,
  changeId: string, include: boolean): string {
  const git = analyse(gitText);
  const shared = analyse(sharedText);
  const local = analyse(localText);
  if (git.duplicates.size || shared.duplicates.size || local.duplicates.size) {
    throw new Error('Local-file changes are ambiguous because a localisation key is repeated');
  }
  if (changeId === '__file_structure__') {
    const structuralKeys = new Set(git.order.filter((key) => shared.lines.has(key)));
    if (structureSignature(git.records, structuralKeys) === structureSignature(shared.records, structuralKeys)) {
      throw new Error('The shared structure change is no longer current');
    }
    const variant = captureLocalisationVariant(gitText, localText);
    if (include) variant.set(changeId, sharedText);
    else variant.delete(changeId);
    return projectLocalisationVariant(gitText, variant);
  }
  if (!String(changeId).startsWith('key:')) throw new Error('Unknown local-file change');
  const key = String(changeId).slice(4);
  if (sameLine(git.lines.get(key) ?? null, shared.lines.get(key) ?? null)) {
    throw new Error('The shared change is no longer current');
  }
  const choices = new Map<string, string | null>(local.lines);
  choices.set(key, include ? (shared.lines.get(key) ?? null) : (git.lines.get(key) ?? null));
  const preferred = include
    ? [...shared.order, ...git.order.filter((candidate) => !shared.lines.has(candidate))]
    : [...git.order, ...shared.order.filter((candidate) => !git.lines.has(candidate))];
  preferred.push(...local.order.filter((candidate) => !preferred.includes(candidate)));
  return renderWithChoices(localText, choices, [...new Set(preferred)]);
}
