import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { TRACKED_PATH_PATTERN } from '../../../packages/shared/src/constants.mts';

const runFile = promisify(execFile);
const SPARSE_PATHS = ['localisation/russian', 'localisation/english', 'localisation/replace'];

function repositoryUrl(value) {
  const repository = String(value ?? '').trim();
  if (!repository) return '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    return `https://github.com/${repository}.git`;
  }
  if (/^(?:https?|file):\/\//u.test(repository)) return repository;
  throw new Error('Canonical Git repository must be owner/name or an HTTP(S)/file URL');
}

function githubRepositoryFromUrl(url) {
  return /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/u.exec(url)?.[1]
    ?.replace(/\.git$/u, '') ?? '';
}

function documentParts(documentId) {
  const separator = documentId.indexOf(':');
  const branch = documentId.slice(0, separator);
  const relativePath = documentId.slice(separator + 1);
  if (branch.startsWith('ticket-')) return null;
  if (!branch || branch.startsWith('-') || !TRACKED_PATH_PATTERN.test(relativePath)) return null;
  return { branch, relativePath };
}

export class GitBranchCache {
  constructor(dataDirectory, repository, {
    refreshMilliseconds = 60_000, fetchImplementation = fetch, branchRepositories = {},
  } = {}) {
    this.url = repositoryUrl(repository);
    this.githubRepository = githubRepositoryFromUrl(this.url);
    this.branchUrls = new Map(Object.entries(branchRepositories)
      .map(([branch, value]) => [branch, repositoryUrl(value)]));
    this.fetch = fetchImplementation;
    this.root = path.resolve(dataDirectory, 'git-cache');
    this.refreshMilliseconds = refreshMilliseconds;
    this.branches = new Map();
    this.operations = new Map();
    this.mergeChecks = new Map();
    this.remoteHeads = null;
    this.remoteHeadsPromise = null;
  }

  get enabled() {
    return Boolean(this.url);
  }

  sourceUrl(branch) {
    return this.branchUrls.get(branch) ?? this.url;
  }

  branchDirectory(branch) {
    const hash = crypto.createHash('sha256').update(branch).digest('hex');
    const result = path.resolve(this.root, hash);
    if (path.dirname(result) !== this.root) throw new Error('Invalid Git cache path');
    return result;
  }

  async git(cwd, args, { timeout = 0 } = {}) {
    const result = await runFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      timeout,
    });
    return result.stdout.trim();
  }

  async refreshBranch(branch, { force = false } = {}) {
    if (!this.enabled) return null;
    const known = this.branches.get(branch);
    const age = known ? Date.now() - known.checkedAt : Infinity;
    if ((!force && known && age < this.refreshMilliseconds)
      || (force && known && age < Math.min(5_000, this.refreshMilliseconds))) return known;
    if (this.operations.has(branch)) return this.operations.get(branch);
    const operation = this.refreshBranchExclusive(branch)
      .catch(async (error) => {
        const target = this.branchDirectory(branch);
        try {
          const commit = await this.git(target, ['rev-parse', 'HEAD']);
          let deleted = false;
          try {
            await this.git(target, ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]);
          } catch (probeError) {
            deleted = probeError.code === 2;
          }
          const fallback = {
            branch, commit, checkedAt: Date.now(), directory: target, stale: true, deleted,
            changedFiles: known?.changedFiles ?? [],
          };
          this.branches.set(branch, fallback);
          return fallback;
        } catch {
          throw error;
        }
      })
      .finally(() => this.operations.delete(branch));
    this.operations.set(branch, operation);
    return operation;
  }

  async head(branch, options = {}) {
    const value = await this.refreshBranch(branch, options);
    return value ? {
      branch: value.branch, commit: value.commit, checkedAt: value.checkedAt,
      stale: value.stale === true, deleted: value.deleted === true,
    } : null;
  }

  async remoteBranchNames({ force = false } = {}) {
    if (!this.enabled) return new Set();
    if (!force && this.remoteHeads
      && Date.now() - this.remoteHeads.checkedAt < this.refreshMilliseconds) return this.remoteHeads.names;
    if (this.remoteHeadsPromise) return this.remoteHeadsPromise;
    this.remoteHeadsPromise = (async () => {
      await fs.mkdir(this.root, { recursive: true });
      const output = await this.git(this.root, ['ls-remote', '--heads', this.url], { timeout: 10_000 });
      const names = new Set(output.split(/\r?\n/u)
        .map((line) => /^\S+\s+refs\/heads\/(.+)$/u.exec(line)?.[1])
        .filter(Boolean));
      for (const [branch, url] of this.branchUrls) {
        // An equally named branch in the main repository must not mask a deleted fork branch.
        names.delete(branch);
        const external = await this.git(this.root, [
          'ls-remote', '--heads', url, `refs/heads/${branch}`,
        ], { timeout: 10_000 });
        if (external.split(/\r?\n/u).some((line) => line.endsWith(`refs/heads/${branch}`))) {
          names.add(branch);
        }
      }
      this.remoteHeads = { names, checkedAt: Date.now() };
      return names;
    })().finally(() => { this.remoteHeadsPromise = null; });
    return this.remoteHeadsPromise;
  }

  async branchDeleted(branch) {
    if (!this.enabled) return false;
    return !(await this.remoteBranchNames()).has(branch);
  }

  async listFiles(branch) {
    const value = await this.refreshBranch(branch);
    if (!value) return [];
    const output = await this.git(value.directory, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...SPARSE_PATHS]);
    return output.split(/\r?\n/u).filter((file) => TRACKED_PATH_PATTERN.test(file));
  }

  async githubJson(endpoint) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    timer.unref();
    try {
      const response = await this.fetch(`https://api.github.com/repos/${this.githubRepository}/${endpoint}`, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EaW-Localisation-Hub' },
      });
      if (!response.ok) return null;
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async mergedInto(sourceBranch, targetBranch, sourceCommit, targetCommit,
    { sourceStale = false, sourceDeleted = false } = {}) {
    if (!this.githubRepository || !/^[0-9a-f]{40}$/u.test(sourceCommit)
      || !/^[0-9a-f]{40}$/u.test(targetCommit)) return false;
    const key = `${sourceBranch}\0${sourceCommit}\0${targetBranch}\0${targetCommit}`;
    const cached = this.mergeChecks.get(key);
    if (cached && cached.until > Date.now()) return cached.merged;
    const comparison = /** @type {{status?: string, base_commit?: {sha?: string}, head_commit?: {sha?: string}, commits?: {parents?: {sha?: string}[]}[]} | null} */ (
      sourceStale ? null : await this.githubJson(
        `compare/${encodeURIComponent(sourceCommit)}...${encodeURIComponent(targetCommit)}`,
      )
    );
    let merged = comparison
      && ['ahead', 'identical'].includes(comparison.status)
      && String(comparison.base_commit?.sha ?? '').toLowerCase() === sourceCommit
      && String(comparison.head_commit?.sha ?? '').toLowerCase() === targetCommit
      && (comparison.commits ?? []).some((item) =>
        (item.parents ?? []).some((parent) => String(parent.sha ?? '').toLowerCase() === sourceCommit));
    if (!merged && (!sourceStale || sourceDeleted)) {
      const owner = (githubRepositoryFromUrl(this.sourceUrl(sourceBranch))
        || this.githubRepository).split('/')[0];
      const params = new URLSearchParams({
        state: 'closed', base: targetBranch, head: `${owner}:${sourceBranch}`, per_page: '100',
      });
      const pulls = await this.githubJson(`pulls?${params}`);
      merged = Array.isArray(pulls) && pulls.some((pull) => pull.merged_at
        && pull.base?.ref === targetBranch
        && String(pull.head?.sha ?? '').toLowerCase() === sourceCommit);
    }
    this.mergeChecks.set(key, { merged: Boolean(merged), until: Date.now() + 60 * 60_000 });
    if (this.mergeChecks.size > 256) this.mergeChecks.delete(this.mergeChecks.keys().next().value);
    return Boolean(merged);
  }

  async refreshBranchExclusive(branch) {
    await fs.mkdir(this.root, { recursive: true });
    const target = this.branchDirectory(branch);
    const sourceUrl = this.sourceUrl(branch);
    const gitDirectory = path.join(target, '.git');
    let changedFiles = this.branches.get(branch)?.changedFiles ?? [];
    try {
      await fs.access(gitDirectory);
      if (await this.git(target, ['remote', 'get-url', 'origin']) !== sourceUrl) {
        await this.git(target, ['remote', 'set-url', 'origin', sourceUrl]);
      }
      const previousCommit = await this.git(target, ['rev-parse', 'HEAD']);
      await this.git(target, ['fetch', '--depth=1', 'origin', branch]);
      const nextCommit = await this.git(target, ['rev-parse', 'FETCH_HEAD']);
      if (previousCommit !== nextCommit) {
        const changed = await this.git(target, [
          'diff', '--name-only', previousCommit, nextCommit, '--', ...SPARSE_PATHS,
        ]);
        changedFiles = changed.split(/\r?\n/u)
          .map((value) => value.trim().replaceAll('\\', '/'))
          .filter((value) => TRACKED_PATH_PATTERN.test(value));
      }
      // target is a validated child of the dedicated server-owned cache.
      await this.git(target, ['reset', '--hard', 'FETCH_HEAD']);
      await this.git(target, ['sparse-checkout', 'set', ...SPARSE_PATHS]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.rm(target, { recursive: true, force: true });
      await fs.rm(temporary, { recursive: true, force: true });
      try {
        await this.git(this.root, [
          'clone', '--depth=1', '--filter=blob:none', '--sparse', '--single-branch',
          '--branch', branch, sourceUrl, temporary,
        ]);
        await this.git(temporary, ['sparse-checkout', 'set', ...SPARSE_PATHS]);
        await fs.rename(temporary, target);
      } catch (cloneError) {
        await fs.rm(temporary, { recursive: true, force: true });
        throw cloneError;
      }
    }
    const value = {
      branch,
      commit: await this.git(target, ['rev-parse', 'HEAD']),
      checkedAt: Date.now(),
      directory: target,
      changedFiles,
    };
    this.branches.set(branch, value);
    return value;
  }

  async snapshot(documentId, options = {}) {
    const parts = documentParts(documentId);
    if (!this.enabled || !parts) return null;
    const branch = await this.refreshBranch(parts.branch, options);
    const target = path.resolve(branch.directory, ...parts.relativePath.split('/'));
    const relative = path.relative(branch.directory, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Canonical file escaped the Git cache');
    }
    let text;
    try {
      text = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Canonical file does not exist in branch ${parts.branch}`);
      throw error;
    }
    return {
      branch: parts.branch,
      commit: branch.commit,
      stale: branch.stale === true,
      deleted: branch.deleted === true,
      blob: await this.git(branch.directory, ['rev-parse', `HEAD:${parts.relativePath}`]),
      checkedAt: branch.checkedAt,
      changedFiles: branch.changedFiles ?? [],
      text: text.replace(/^\uFEFF/u, ''),
    };
  }

  async changedFilesSince(documentId, localHead) {
    const parts = documentParts(documentId);
    if (!this.enabled || !parts || !/^[0-9a-f]{40,64}$/iu.test(String(localHead ?? ''))) return [];
    const branch = await this.refreshBranch(parts.branch);
    if (localHead === branch.commit) return [];
    try {
      await this.git(branch.directory, ['cat-file', '-e', `${localHead}^{commit}`]);
    } catch {
      await this.git(branch.directory, ['fetch', '--deepen=256', 'origin', parts.branch]);
    }
    const changed = await this.git(branch.directory, [
      'diff', '--name-only', localHead, branch.commit, '--', ...SPARSE_PATHS,
    ]);
    return changed.split(/\r?\n/u)
      .map((value) => value.trim().replaceAll('\\', '/'))
      .filter((value) => TRACKED_PATH_PATTERN.test(value))
      .slice(0, 500);
  }
}
