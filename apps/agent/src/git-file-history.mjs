import path from 'node:path';
import { withoutUtf8Bom } from '../../../packages/shared/src/text.mjs';
import { runGitSync } from './git-executable.mjs';

const COMMIT_PREFIX = '__EAW_HUB_COMMIT__';
const FIELD_SEPARATOR = '\x1f';
const MAXIMUM_HISTORY_OFFSET = 50_000;
const MAXIMUM_PAGE_SIZE = 100;

function supportedRelativePath(value) {
  const relative = String(value ?? '').replaceAll('\\', '/');
  if (!relative || relative.startsWith('/') || relative.includes('\0')) {
    throw new Error('Некорректный путь файла Git.');
  }
  const normalised = path.posix.normalize(relative);
  if (normalised !== relative || normalised.startsWith('../')) {
    throw new Error('Файл находится вне репозитория.');
  }
  if (!/^localisation\/(?:russian|english|replace)\/.+\.ya?ml$/iu.test(normalised)) {
    throw new Error('Файл не входит в поддерживаемую локализацию.');
  }
  return normalised;
}

function runGit(repository, args, maximumBytes = 32 * 1024 * 1024) {
  const result = runGitSync(args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: maximumBytes,
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || 'Git command failed').trim());
  }
  return result.stdout;
}

function parseHistory(output, currentPath) {
  const entries = [];
  let historicalPath = currentPath;
  const blocks = String(output).split(COMMIT_PREFIX).slice(1);
  for (const block of blocks) {
    const lines = block.replace(/^\r?\n/u, '').split(/\r?\n/u);
    const header = lines.shift() ?? '';
    const [commit, shortCommit, author, date, ...subjectParts] = header.split(FIELD_SEPARATOR);
    if (!/^[0-9a-f]{40,64}$/iu.test(commit ?? '')) continue;
    const pathAtCommit = historicalPath;
    for (const line of lines) {
      const fields = line.split('\t');
      if (!fields[0]?.startsWith('R') || fields.length < 3) continue;
      const previousPath = fields[1].replaceAll('\\', '/');
      const nextPath = fields[2].replaceAll('\\', '/');
      if (nextPath === historicalPath) historicalPath = previousPath;
    }
    entries.push({
      commit,
      shortCommit: shortCommit || commit.slice(0, 10),
      author: author || 'Git',
      date: date || '',
      subject: subjectParts.join(FIELD_SEPARATOR) || '(без сообщения)',
      historicalPath: supportedRelativePath(pathAtCommit),
    });
  }
  return entries;
}

export function listFileHistory(repository, relativePath, options = {}) {
  const trackedPath = supportedRelativePath(relativePath);
  const offset = Math.min(MAXIMUM_HISTORY_OFFSET, Math.max(0, Number(options.offset) || 0));
  const limit = Math.min(MAXIMUM_PAGE_SIZE, Math.max(1, Number(options.limit) || 50));
  const needed = offset + limit + 1;
  const output = runGit(repository, [
    'log', '--follow', '--find-renames', `--max-count=${needed}`,
    `--format=${COMMIT_PREFIX}%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s`,
    '--name-status', '--', trackedPath,
  ]);
  const all = parseHistory(output, trackedPath);
  return {
    entries: all.slice(offset, offset + limit),
    offset,
    nextOffset: offset + Math.min(limit, Math.max(0, all.length - offset)),
    hasMore: all.length > offset + limit,
  };
}

function showFile(repository, revision, relativePath) {
  const shown = runGit(repository, ['show', `${revision}:${supportedRelativePath(relativePath)}`], 16 * 1024 * 1024);
  return withoutUtf8Bom(shown);
}

function validatedRevision(repository, revision, label) {
  const value = String(revision ?? '');
  if (value !== 'HEAD' && !/^[0-9a-f]{40,64}$/iu.test(value)) {
    throw new Error(`Некорректный Git commit (${label}).`);
  }
  const resolved = runGit(repository, ['rev-parse', `${value}^{commit}`]).trim();
  const ancestor = runGitSync(['merge-base', '--is-ancestor', resolved, 'HEAD'], {
    cwd: repository, windowsHide: true, stdio: 'ignore',
  });
  if (ancestor.status !== 0) throw new Error(`Commit (${label}) не входит в историю текущей ветки.`);
  return resolved;
}

export function fileHistoryDiff(
  repository,
  relativePath,
  fromCommit,
  fromHistoricalPath = relativePath,
  toCommit = 'HEAD',
  toHistoricalPath = relativePath,
) {
  const currentPath = supportedRelativePath(relativePath);
  const fromPath = supportedRelativePath(fromHistoricalPath);
  const toPath = supportedRelativePath(toHistoricalPath);
  const from = validatedRevision(repository, fromCommit, 'слева');
  const to = validatedRevision(repository, toCommit, 'справа');
  return {
    commit: from,
    head: to,
    fromCommit: from,
    toCommit: to,
    baseText: showFile(repository, from, fromPath),
    headText: showFile(repository, to, toPath),
    historicalPath: fromPath,
    targetPath: toPath,
    currentPath,
  };
}

export const gitFileHistoryLimits = Object.freeze({
  maximumOffset: MAXIMUM_HISTORY_OFFSET,
  maximumPageSize: MAXIMUM_PAGE_SIZE,
});
