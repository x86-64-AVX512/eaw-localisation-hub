import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

let cachedExecutable = '';

function githubDesktopCandidates(environment, readDirectory = fs.readdirSync) {
  const root = environment.LOCALAPPDATA
    ? path.join(environment.LOCALAPPDATA, 'GitHubDesktop') : '';
  if (!root) return [];
  let versions = [];
  try {
    versions = readDirectory(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('app-'))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {}
  return versions.flatMap((directory) => {
    const bundled = path.join(root, directory, 'resources', 'app', 'git');
    return [path.join(bundled, 'cmd', 'git.exe'), path.join(bundled, 'mingw64', 'bin', 'git.exe')];
  });
}

export function gitExecutableCandidates(
  environment = process.env,
  platform = process.platform,
  readDirectory = fs.readdirSync,
) {
  const candidates = [];
  if (environment.EAW_HUB_GIT?.trim()) candidates.push(path.resolve(environment.EAW_HUB_GIT.trim()));
  candidates.push('git');
  if (platform !== 'win32') return candidates;
  candidates.push(...githubDesktopCandidates(environment, readDirectory));
  for (const root of [
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Programs'),
    environment.ProgramFiles,
    environment.ProgramW6432,
    environment['ProgramFiles(x86)'],
  ].filter(Boolean)) candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
  return [...new Set(candidates.map((candidate) => candidate.toLowerCase()))]
    .map((normalised) => candidates.find((candidate) => candidate.toLowerCase() === normalised));
}

export function discoverGitExecutable(options = {}) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? ((candidate) => spawnSync(candidate, ['--version'], {
    encoding: 'utf8', windowsHide: true,
  }).status === 0);
  for (const candidate of gitExecutableCandidates(environment, platform, options.readDirectory)) {
    try {
      if (probe(candidate)) return candidate;
    } catch {}
  }
  throw new Error(
    'Git не найден. Установите Git for Windows либо GitHub Desktop и полностью перезапустите Desktop Agent.',
  );
}

export function gitExecutable() {
  cachedExecutable ||= discoverGitExecutable();
  return cachedExecutable;
}

export function runGitSync(args, options = {}) {
  return spawnSync(gitExecutable(), args, { windowsHide: true, ...options });
}

export function resetGitExecutableForTests() {
  cachedExecutable = '';
}
