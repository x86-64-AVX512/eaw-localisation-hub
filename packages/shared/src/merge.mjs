function splitLines(text) {
  if (!text) return [];
  const records = [];
  let position = 0;
  while (position < text.length) {
    let end = text.indexOf('\n', position);
    if (end < 0) end = text.length;
    else end += 1;
    const raw = text.slice(position, end);
    const eol = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    const content = eol ? raw.slice(0, -eol.length) : raw;
    const match = /^[ \t]*([^#\s][^:\r\n]*):\d+[ \t]+/.exec(content);
    records.push({ content, eol, key: match ? match[1].trim() : null });
    position = end;
  }
  return records;
}

function analyse(text) {
  const records = splitLines(text);
  const lines = new Map();
  const duplicates = new Set();
  const order = [];
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
    nonKeySignature: records.filter(({ key }) => !key).map(({ content }) => content).join('\n'),
  };
}

function sameLine(left, right) {
  return (left ?? null) === (right ?? null);
}

function resolutionFor(resolutions, key) {
  if (resolutions instanceof Map) return resolutions.get(key);
  return resolutions?.[key];
}

function lineEnding(records) {
  return records.find(({ eol }) => eol)?.eol ?? '\r\n';
}

function renderWithChoices(templateText, choices, preferredOrder) {
  const records = splitLines(templateText);
  const eol = lineEnding(records);
  const rendered = [];
  const existing = new Set();
  for (const record of records) {
    if (!record.key) {
      rendered.push({ ...record });
      continue;
    }
    const chosen = choices.get(record.key);
    if (chosen == null) continue;
    existing.add(record.key);
    rendered.push({ content: chosen, eol: record.eol, key: record.key });
  }

  for (const key of preferredOrder) {
    const chosen = choices.get(key);
    if (chosen == null || existing.has(key)) continue;
    const referenceIndex = preferredOrder.indexOf(key);
    const nextKeys = preferredOrder.slice(referenceIndex + 1);
    const previousKeys = preferredOrder.slice(0, referenceIndex).reverse();
    let insertion = -1;
    for (const next of nextKeys) {
      insertion = rendered.findIndex((record) => record.key === next);
      if (insertion >= 0) break;
    }
    if (insertion < 0) {
      for (const previous of previousKeys) {
        const previousIndex = rendered.findIndex((record) => record.key === previous);
        if (previousIndex >= 0) {
          insertion = previousIndex + 1;
          break;
        }
      }
    }
    if (insertion < 0) insertion = rendered.length;
    if (insertion > 0 && !rendered[insertion - 1].eol) rendered[insertion - 1].eol = eol;
    rendered.splice(insertion, 0, { content: chosen, eol, key });
    existing.add(key);
  }
  return rendered.map(({ content, eol: ending }) => content + ending).join('');
}

export function mergeLocalisationThreeWay(baseText, collaborativeText, externalText, resolutions = {}) {
  if (collaborativeText === externalText) {
    return { text: collaborativeText, conflicts: [], changed: false };
  }

  const base = analyse(baseText);
  const collaborative = analyse(collaborativeText);
  const external = analyse(externalText);
  const conflicts = [];
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

  const baseStructure = base.nonKeySignature;
  const collaborativeStructure = collaborative.nonKeySignature;
  const externalStructure = external.nonKeySignature;
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
  const choices = new Map();
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

export function localisationChangedKeys(previousText, currentText) {
  const previous = analyse(previousText);
  const current = analyse(currentText);
  const changed = new Set();
  for (const key of new Set([...previous.lines.keys(), ...current.lines.keys()])) {
    if (!sameLine(previous.lines.get(key), current.lines.get(key))) changed.add(key);
  }
  if (previous.nonKeySignature !== current.nonKeySignature) changed.add('__file_structure__');
  return changed;
}

export function captureLocalisationVariant(previousText, currentText) {
  const previous = analyse(previousText);
  const current = analyse(currentText);
  const changed = new Map();
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

export function projectLocalisationVariant(gitText, variant) {
  const git = analyse(gitText);
  if (git.duplicates.size) return gitText;
  const choices = new Map(git.lines);
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

export function localisationVariantConflicts(gitText, variants, ownerNames = new Map()) {
  const git = analyse(gitText);
  const byKey = new Map();
  for (const [authorId, variant] of variants ?? []) {
    for (const [key, line] of variant) {
      if (key === '__file_structure__') continue;
      if (sameLine(line, git.lines.get(key) ?? null)) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ authorId, author: ownerNames.get(authorId) ?? 'Unknown', line });
    }
  }
  return [...byKey]
    .filter(([, items]) => new Set(items.map((item) => item.line)).size > 1)
    .map(([key, items]) => ({ key, baseLine: git.lines.get(key) ?? null, variants: items }));
}

export function projectLocalisationOwnership(gitText, currentText, ownership, userId) {
  const git = analyse(gitText);
  const current = analyse(currentText);
  if (git.duplicates.size || current.duplicates.size) return gitText;
  const choices = new Map();
  for (const key of new Set([...git.lines.keys(), ...current.lines.keys()])) {
    choices.set(key, ownership.get(key) === userId
      ? (current.lines.get(key) ?? null)
      : (git.lines.get(key) ?? null));
  }
  const template = ownership.get('__file_structure__') === userId ? currentText : gitText;
  const order = [...git.order, ...current.order.filter((key) => !git.lines.has(key))];
  return renderWithChoices(template, choices, order);
}
