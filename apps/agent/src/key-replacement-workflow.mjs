import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  localisationEntries, parseKeyReplacementBatch, replaceLocalisationValues,
} from '../../../packages/shared/src/localisation-replace.mjs';
import {
  readTrackedTextFile, withoutUtf8Bom, withUtf8Bom, writeTrackedTextFile,
} from '../../../packages/shared/src/text.mjs';

const MAX_BATCH_ENTRIES = 500;

function replacementRoots(root, language) {
  if (language === 'english') return [
    path.join(root, 'localisation', 'english'),
    path.join(root, 'localisation', 'replace', 'english'),
  ];
  if (language === 'russian') return [
    path.join(root, 'localisation', 'russian'),
    path.join(root, 'localisation', 'replace', 'russian'),
  ];
  throw new Error('Выберите русские или английские файлы локализации.');
}

async function localisationFiles(root, language) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) result.push(absolute);
    }
  }
  for (const base of replacementRoots(root, language)) {
    try {
      await visit(base);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class KeyReplacementWorkflow {
  constructor(hub) { this.hub = hub; }

  async preview(input, language = 'russian') {
    if (this.hub.assertCanonicalGitHead) await this.hub.assertCanonicalGitHead();
    const parsed = parseKeyReplacementBatch(input);
    if (parsed.entries.length > MAX_BATCH_ENTRIES) {
      parsed.errors.push({ line: 0, message: `За один раз допускается не более ${MAX_BATCH_ENTRIES} ключей.` });
    }
    if (parsed.errors.length || parsed.duplicateKeys.length) {
      return { ...parsed, missingKeys: [], duplicateMatches: [], changes: [], files: [] };
    }
    const wanted = new Map(parsed.entries.map((entry) => [entry.key, entry.text]));
    const found = new Map(parsed.entries.map((entry) => [entry.key, []]));
    const fileValues = [];
    for (const absolutePath of await localisationFiles(this.hub.options.repo, language)) {
      const text = withoutUtf8Bom(await readTrackedTextFile(this.hub.options.repo, absolutePath));
      const relativePath = path.relative(this.hub.options.repo, absolutePath).replaceAll('\\', '/');
      const matches = localisationEntries(text).filter((entry) => wanted.has(entry.key));
      if (!matches.length) continue;
      for (const match of matches) found.get(match.key).push({ file: relativePath, oldText: match.text });
      const changed = replaceLocalisationValues(text, wanted);
      fileValues.push({
        path: relativePath, hash: digest(text), text,
        nextText: changed.text,
      });
    }
    const missingKeys = [...found].filter(([, matches]) => matches.length === 0).map(([key]) => key);
    const duplicateMatches = [...found].filter(([, matches]) => matches.length > 1)
      .map(([key, matches]) => ({ key, matches }));
    const changes = [...found].flatMap(([key, matches]) => matches.length === 1 ? [{
      key, file: matches[0].file, oldText: matches[0].oldText, newText: wanted.get(key),
    }] : []);
    const files = fileValues.filter((file) => file.text !== file.nextText)
      .map(({ path: filePath, hash }) => ({ path: filePath, hash }));
    return {
      entries: parsed.entries, errors: [], duplicateKeys: [], missingKeys,
      duplicateMatches, changes, files, language,
    };
  }

  async apply(input, expectedFiles, language = 'russian') {
    const preview = await this.preview(input, language);
    if (preview.errors.length || preview.duplicateKeys.length || preview.missingKeys.length
      || preview.duplicateMatches.length) throw new Error('Предпросмотр содержит ошибки; применение остановлено.');
    const expected = new Map((Array.isArray(expectedFiles) ? expectedFiles : [])
      .map((file) => [String(file.path), String(file.hash)]));
    if (expected.size !== preview.files.length
      || preview.files.some((file) => expected.get(file.path) !== file.hash)) {
      throw new Error('Файлы изменились после предпросмотра. Обновите предпросмотр и повторите операцию.');
    }
    const wanted = new Map(preview.entries.map((entry) => [entry.key, entry.text]));
    const originals = [];
    try {
      for (const file of preview.files) {
        const absolutePath = path.resolve(this.hub.options.repo, file.path);
        const original = withoutUtf8Bom(await readTrackedTextFile(this.hub.options.repo, absolutePath));
        if (digest(original) !== file.hash) throw new Error(`Файл ${file.path} изменился во время применения.`);
        const next = replaceLocalisationValues(original, wanted).text;
        originals.push({ absolutePath, original });
        await writeTrackedTextFile(this.hub.options.repo, absolutePath, withUtf8Bom(next));
      }
    } catch (error) {
      for (const item of originals.toReversed()) {
        await writeTrackedTextFile(this.hub.options.repo, item.absolutePath, withUtf8Bom(item.original)).catch(() => {});
      }
      throw error;
    }
    return { changedKeys: preview.changes.length, changedFiles: preview.files.length };
  }
}
