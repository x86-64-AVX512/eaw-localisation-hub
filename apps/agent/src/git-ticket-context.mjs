import { runGitSync } from './git-executable.mjs';
import { withoutUtf8Bom } from '../../../packages/shared/src/text.mjs';

function decode(value) {
  return Buffer.from(String(value ?? ''), 'base64').toString('utf8');
}

export function currentGitCommit(repository) {
  const commit = runGitSync(['rev-parse', 'HEAD'], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
  });
  if (commit.status !== 0 || !/^[0-9a-f]{40,64}$/iu.test(commit.stdout.trim())) {
    throw new Error('Не удалось определить текущий Git-коммит.');
  }
  return commit.stdout.trim().toLowerCase();
}

export function currentGitFileBlob(repository, relativePath) {
  const normalised = String(relativePath ?? '').replaceAll('\\', '/');
  if (!/^localisation\/(?:russian|english|replace(?:\/(?:russian|english))?)\/[^\0]+\.yml$/iu.test(normalised)) {
    throw new Error('Файл не входит в поддерживаемые папки локализации.');
  }
  const blob = runGitSync(['rev-parse', `HEAD:${normalised}`], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
  });
  if (blob.status !== 0 || !/^[0-9a-f]{40,64}$/iu.test(blob.stdout.trim())) {
    throw new Error('Не удалось определить Git-версию файла. Обновите репозиторий через GitHub Desktop.');
  }
  return blob.stdout.trim().toLowerCase();
}

export async function ticketBootstrap(hub, ticketId, relativePath) {
  const payload = await hub.ticketRequest(`/api/tickets/${encodeURIComponent(ticketId)}/snapshot`, { method: 'GET' });
  const ticket = payload.ticket;
  if (!ticket?.files?.includes(relativePath)) throw new Error('Файл не входит в выбранный тикет.');
  const shown = runGitSync(['show', `${ticket.baseCommit}:${relativePath}`], {
    cwd: hub.options.repo, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (shown.status !== 0) {
    throw new Error('Базовый коммит тикета отсутствует в локальном репозитории. Обновите его через GitHub Desktop.');
  }
  const snapshot = payload.files?.find((file) => file.path === relativePath);
  if (!snapshot) throw new Error('Р¤Р°Р№Р» С‚РёРєРµС‚Р° РЅРµ РЅР°Р№РґРµРЅ РЅР° СЃРµСЂРІРµСЂРµ.');
  return {
    ticket,
    text: snapshot.ticketInitialised
      ? withoutUtf8Bom(decode(snapshot.ticketTextBase64))
      : withoutUtf8Bom(shown.stdout),
  };
}

export async function englishOriginal(hub, key, ticketId = '') {
  const localisationKey = String(key ?? '').trim();
  if (!localisationKey || localisationKey.length > 512 || /[\u0000-\u0020\u007f:]/u.test(localisationKey)) {
    throw new Error('Не удалось определить ключ локализации под курсором.');
  }
  let commit = currentGitCommit(hub.options.repo);
  if (ticketId) {
    const payload = await hub.ticketRequest(`/api/tickets/${encodeURIComponent(ticketId)}`, { method: 'GET' });
    commit = payload.ticket.baseCommit;
  }
  const searched = runGitSync([
    'grep', '-n', '-F', '-e', `${localisationKey}:`, commit, '--',
    'localisation/english', 'localisation/replace/english',
  ], {
    cwd: hub.options.repo, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (![0, 1].includes(searched.status)) throw new Error('Не удалось прочитать английскую локализацию из Git.');
  const prefix = `${commit}:`;
  const matches = [];
  for (const line of searched.stdout.split(/\r?\n/u)) {
    const value = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const match = /^(localisation\/(?:english|replace\/english)\/[^:]+):(\d+):(.*)$/u.exec(value);
    if (!match) continue;
    const entry = /^\s*([^#\s][^:]*?):\d+\s+"((?:[^"\\]|\\.)*)"/u.exec(match[3]);
    if (!entry || entry[1].trim() !== localisationKey) continue;
    matches.push({ file: match[1], line: Number(match[2]), key: localisationKey, text: entry[2] });
    if (matches.length >= 20) break;
  }
  return { key: localisationKey, commit, matches };
}
