import fs from 'node:fs/promises';
import path from 'node:path';

// A structural lexer: comments and quoted values never masquerade as defined_text
// declarations. We only collect direct name assignments in a complete block.
export function scriptedLocalisationDefinitions(text, relativePath) {
  const tokens = []; let line = 1;
  for (let cursor = 0; cursor < text.length;) {
    const character = text[cursor];
    if (/\s|\uFEFF/u.test(character)) { if (character === '\n') line += 1; cursor += 1; continue; }
    if (character === '#') { while (cursor < text.length && text[cursor] !== '\n') cursor += 1; continue; }
    if ('={}'.includes(character)) { tokens.push({ value: character, line }); cursor += 1; continue; }
    const startLine = line;
    if (character === '"') {
      let value = '', closed = false; cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === '"') { cursor += 1; closed = true; break; }
        if (text[cursor] === '\n') line += 1;
        if (text[cursor] === '\\' && cursor + 1 < text.length) cursor += 1;
        value += text[cursor++];
      }
      if (!closed) return { definitions: [], complete: false };
      tokens.push({ value, line: startLine, quoted: true });
    } else {
      const start = cursor;
      while (cursor < text.length && !/[\s={}#"]/u.test(text[cursor])) cursor += 1;
      tokens.push({ value: text.slice(start, cursor), line: startLine });
    }
  }
  const definitions = [], stack = []; let candidate = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!stack.length && token.value === 'defined_text' && !token.quoted
      && tokens[index + 1]?.value === '=' && tokens[index + 2]?.value === '{') candidate = {};
    if (token.value === '{' && !token.quoted) { stack.push(candidate); candidate = null; }
    else if (token.value === '}' && !token.quoted) {
      if (!stack.length) return { definitions: [], complete: false };
      const block = stack.pop();
      if (!stack.length && block?.name) definitions.push({ name: block.name, path: relativePath, line: block.line });
    } else if (stack.length === 1 && stack[0] && token.value === 'name' && !token.quoted
      && tokens[index + 1]?.value === '=' && tokens[index + 2]) {
      const value = tokens[index + 2];
      if (/^[A-Za-z0-9_]+$/u.test(value.value)) { stack[0].name = value.value; stack[0].line = value.line; }
    }
  }
  return { definitions: stack.length ? [] : definitions, complete: stack.length === 0 };
}

export async function collectScriptedLocalisation(repository, fileCache = new Map()) {
  const root = path.join(repository, 'common', 'scripted_localisation');
  let canonical;
  try { canonical = await fs.realpath(root); }
  catch (error) { if (error.code === 'ENOENT') { fileCache.clear(); return { definitions: [], complete: true }; } throw error; }
  const inside = (location) => { const relative = path.relative(repository, location); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
  if (!inside(canonical)) return { definitions: [], complete: false };
  const definitions = [], seen = new Set(); let complete = true, bytes = 0, files = 0;
  const walk = async (directory, depth = 0) => {
    if (depth > 32) { complete = false; return; }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!complete) break;
      const location = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(location, depth + 1); continue; }
      if (!entry.isFile() || !/\.txt$/iu.test(entry.name)) continue;
      const resolved = await fs.realpath(location);
      if (!inside(resolved)) continue;
      const stat = await fs.stat(resolved, { bigint: true });
      if (++files > 5000 || Number(stat.size) > 4 * 1024 * 1024 || (bytes += Number(stat.size)) > 64 * 1024 * 1024) { complete = false; break; }
      const cached = fileCache.get(resolved);
      seen.add(resolved);
      let parsed;
      if (cached?.size === stat.size && cached.mtimeNs === stat.mtimeNs && cached.ctimeNs === stat.ctimeNs) parsed = cached.parsed;
      else {
        parsed = scriptedLocalisationDefinitions(await fs.readFile(resolved, 'utf8'), path.relative(repository, resolved).replaceAll('\\', '/'));
        fileCache.set(resolved, { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, parsed });
      }
      definitions.push(...parsed.definitions);
      if (!parsed.complete) complete = false;
    }
  };
  await walk(canonical);
  for (const file of fileCache.keys()) if (!seen.has(file)) fileCache.delete(file);
  definitions.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path) || a.line - b.line);
  return { definitions, complete };
}

let documented = { stamp: '', names: [] };

export function documentedGetterStamp() { return documented.stamp; }

export async function documentedGetterNames() {
  // Optional local documentation only. No executable, decompiled material or
  // guessed list of engine members is shipped as an exhaustive whitelist.
  const game = process.env.EAW_HOI4_DIRECTORY
    || path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Hearts of Iron IV');
  const file = path.join(game, 'documentation', 'loc_objects_documentation.md');
  try {
    const stat = await fs.stat(file, { bigint: true });
    if (stat.size > 4n * 1024n * 1024n) { documented = { stamp: '', names: [] }; return []; }
    // The index refreshes every minute; reread the document only after it changes.
    const stamp = `${file}\n${stat.size}\n${stat.mtimeNs}`;
    if (documented.stamp !== stamp) {
      const source = await fs.readFile(file, 'utf8');
      documented = { stamp, names: [...new Set([...source.matchAll(/\bGet[A-Za-z0-9_]+\b/gu)].map((match) => match[0]))].sort() };
    }
    return documented.names;
  } catch { documented = { stamp: '', names: [] }; return []; }
}
