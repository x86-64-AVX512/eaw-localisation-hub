import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawnSync } from 'node:child_process';
import type { ExecFileOptionsWithStringEncoding, SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

type DirectoryEntry = { name: string; isDirectory(): boolean };
type ReadDirectory = (directory: string, options: { withFileTypes: true }) => DirectoryEntry[];
type GitEnvironment = NodeJS.ProcessEnv;

interface DiscoveryOptions {
  environment?: GitEnvironment;
  platform?: NodeJS.Platform;
  readDirectory?: ReadDirectory;
  probe?: (candidate: string) => boolean;
}

let cachedExecutable = '';

function githubDesktopCandidates(environment: GitEnvironment, readDirectory: ReadDirectory = fs.readdirSync): string[] {
  const root = environment.LOCALAPPDATA
    ? path.join(environment.LOCALAPPDATA, 'GitHubDesktop') : '';
  if (!root) return [];
  let versions: string[] = [];
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
  environment: GitEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  readDirectory: ReadDirectory = fs.readdirSync,
): string[] {
  const candidates: string[] = [];
  if (environment.EAW_HUB_GIT?.trim()) candidates.push(path.resolve(environment.EAW_HUB_GIT.trim()));
  candidates.push('git');
  if (platform !== 'win32') return candidates;
  candidates.push(...githubDesktopCandidates(environment, readDirectory));
  for (const root of [
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Programs'),
    environment.ProgramFiles,
    environment.ProgramW6432,
    environment['ProgramFiles(x86)'],
  ].filter((root): root is string => Boolean(root))) candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
  return [...new Set(candidates.map((candidate) => candidate.toLowerCase()))]
    .map((normalised) => candidates.find((candidate) => candidate.toLowerCase() === normalised)!);
}

export function discoverGitExecutable(options: DiscoveryOptions = {}): string {
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

export function gitExecutable(): string {
  cachedExecutable ||= discoverGitExecutable();
  return cachedExecutable;
}

export function runGitSync(args: string[], options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8' }) {
  const spawnOptions = { windowsHide: true, ...options };
  return spawnSync(gitExecutable(), args, spawnOptions);
}

export function runGitAsync(args: string[], options: Omit<ExecFileOptionsWithStringEncoding, 'encoding'> = {}) {
  return new Promise<{ status: string | number; stdout: string; stderr: string }>((resolve) => {
    const execOptions = { windowsHide: true, ...options } as ExecFileOptionsWithStringEncoding;
    execOptions.encoding ??= 'utf8';
    execFile(gitExecutable(), args, execOptions, (error, stdout, stderr) => {
      resolve({ status: error ? error.code ?? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export function resetGitExecutableForTests(): void {
  cachedExecutable = '';
}
