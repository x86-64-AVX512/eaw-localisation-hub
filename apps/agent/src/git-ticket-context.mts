import { gitExecutable, runGitSync } from './git-executable.mts';
import { withoutUtf8Bom } from '../../../packages/shared/src/text.mts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface TicketSnapshotFile {
  path: string;
  ticketInitialised: boolean;
  ticketTextBase64: string;
}

interface TicketContextHub {
  options: { repo: string };
  ticketRequest(route: string, options: { method: 'GET' }): Promise<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTicketSnapshotFile(value: unknown): value is TicketSnapshotFile {
  return isRecord(value) && typeof value.path === 'string'
    && typeof value.ticketInitialised === 'boolean' && typeof value.ticketTextBase64 === 'string';
}

function decode(value: string): string {
  return Buffer.from(String(value ?? ''), 'base64').toString('utf8');
}

export function currentGitCommit(repository: string): string {
  const commit = runGitSync(['rev-parse', 'HEAD'], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
  });
  if (commit.status !== 0 || !/^[0-9a-f]{40,64}$/iu.test(commit.stdout.trim())) {
    throw new Error('Не удалось определить текущий Git-коммит.');
  }
  return commit.stdout.trim().toLowerCase();
}

export async function currentGitCommitAsync(repository: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(gitExecutable(), ['rev-parse', 'HEAD'], {
      cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    }));
  } catch {
    throw new Error('Не удалось определить текущий Git-коммит.');
  }
  if (!/^[0-9a-f]{40,64}$/iu.test(stdout.trim())) {
    throw new Error('Не удалось определить текущий Git-коммит.');
  }
  return stdout.trim().toLowerCase();
}

export function currentGitFileBlob(repository: string, relativePath: string): string {
  const normalised = checkedGitFilePath(relativePath);
  const blob = runGitSync(['rev-parse', `HEAD:${normalised}`], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
  });
  if (blob.status !== 0 || !/^[0-9a-f]{40,64}$/iu.test(blob.stdout.trim())) {
    throw new Error('Не удалось определить Git-версию файла. Обновите репозиторий через GitHub Desktop.');
  }
  return blob.stdout.trim().toLowerCase();
}

function checkedGitFilePath(relativePath: string): string {
  const normalised = String(relativePath ?? '').replaceAll('\\', '/');
  if (!/^localisation\/(?:russian|english|replace(?:\/(?:russian|english))?)\/[^\0]+\.yml$/iu.test(normalised)) {
    throw new Error('Файл не входит в поддерживаемые папки локализации.');
  }
  return normalised;
}

export async function currentGitFileBlobAsync(repository: string, relativePath: string): Promise<string> {
  const normalised = checkedGitFilePath(relativePath);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(gitExecutable(), ['rev-parse', `HEAD:${normalised}`], {
      cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    }));
  } catch {
    throw new Error('Не удалось определить Git-версию файла. Обновите репозиторий через GitHub Desktop.');
  }
  if (!/^[0-9a-f]{40,64}$/iu.test(stdout.trim())) {
    throw new Error('Не удалось определить Git-версию файла. Обновите репозиторий через GitHub Desktop.');
  }
  return stdout.trim().toLowerCase();
}

export async function ticketBootstrap(hub: TicketContextHub, ticketId: string, relativePath: string) {
  const payload = await hub.ticketRequest(`/api/tickets/${encodeURIComponent(ticketId)}/snapshot`, { method: 'GET' });
  const ticket = payload.ticket;
  if (!isRecord(ticket) || !Array.isArray(ticket.files) || !ticket.files.includes(relativePath)
    || typeof ticket.baseCommit !== 'string') throw new Error('Файл не входит в выбранный тикет.');
  const shown = runGitSync(['show', `${ticket.baseCommit}:${relativePath}`], {
    cwd: hub.options.repo, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (shown.status !== 0) {
    throw new Error('Базовый коммит тикета отсутствует в локальном репозитории. Обновите его через GitHub Desktop.');
  }
  const snapshot = Array.isArray(payload.files)
    ? payload.files.find((file) => isTicketSnapshotFile(file) && file.path === relativePath) : undefined;
  if (!snapshot) throw new Error('Файл тикета не найден на сервере.');
  if (!isTicketSnapshotFile(snapshot)) throw new Error('Invalid ticket snapshot');
  return {
    ticket,
    text: snapshot.ticketInitialised
      ? withoutUtf8Bom(decode(snapshot.ticketTextBase64))
      : withoutUtf8Bom(shown.stdout),
  };
}

export async function englishOriginal(hub: TicketContextHub, key: string, ticketId = '') {
  const localisationKey = String(key ?? '').trim();
  if (!localisationKey || localisationKey.length > 512 || /[\u0000-\u0020\u007f:]/u.test(localisationKey)) {
    throw new Error('Не удалось определить ключ локализации под курсором.');
  }
  let commit = currentGitCommit(hub.options.repo);
  if (ticketId) {
    const payload = await hub.ticketRequest(`/api/tickets/${encodeURIComponent(ticketId)}`, { method: 'GET' });
    if (!isRecord(payload.ticket) || typeof payload.ticket.baseCommit !== 'string') {
      throw new Error('Не удалось определить базовый коммит тикета.');
    }
    commit = payload.ticket.baseCommit;
  }
  const searched = runGitSync([
    'grep', '-n', '-F', '-e', `${localisationKey}:`, commit, '--',
    'localisation/english', 'localisation/replace/english',
  ], {
    cwd: hub.options.repo, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (searched.status !== 0 && searched.status !== 1) throw new Error('Не удалось прочитать английскую локализацию из Git.');
  const prefix = `${commit}:`;
  const matches: { file: string; line: number; key: string; text: string }[] = [];
  for (const line of searched.stdout.split(/\r?\n/u)) {
    const value = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const match = /^(localisation\/(?:english|replace\/english)\/[^:]+):(\d+):(.*)$/u.exec(value);
    if (!match) continue;
    const entry = /^\s*([^#\s][^:]*?):(?:\d+)?\s+"((?:[^"\\]|\\.)*)"/u.exec(match[3]);
    if (!entry || entry[1].trim() !== localisationKey) continue;
    matches.push({ file: match[1], line: Number(match[2]), key: localisationKey, text: entry[2] });
    if (matches.length >= 20) break;
  }
  return { key: localisationKey, commit, matches };
}
