import { AuthError } from './auth.mjs';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;

export class GitCommitVerifier {
  constructor(repository, fetchImplementation = fetch) {
    this.repository = String(repository ?? '').trim();
    if (this.repository && !REPOSITORY_PATTERN.test(this.repository)) {
      throw new Error('EAW_HUB_GITHUB_REPOSITORY must be owner/repository');
    }
    this.fetch = fetchImplementation;
    this.cache = new Map();
  }

  async verify(branch, commit) {
    if (!this.repository) return;
    const key = `${branch}\n${commit}`;
    const cached = this.cache.get(key);
    if (cached && cached > Date.now()) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    timeout.unref();
    let response;
    try {
      response = await this.fetch(
        `https://api.github.com/repos/${this.repository}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(branch)}`,
        { signal: controller.signal, headers: {
          Accept: 'application/vnd.github+json', 'User-Agent': 'EaW-Localisation-Hub',
        } },
      );
    } catch {
      throw new AuthError('GitHub commit verification is unavailable', 503, 'git_verification_unavailable');
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 404 || response.status === 422) {
      throw new AuthError('Base commit does not belong to the selected GitHub branch', 409, 'invalid_ticket_base');
    }
    if (!response.ok) {
      throw new AuthError('GitHub commit verification is unavailable', 503, 'git_verification_unavailable');
    }
    const payload = await response.json().catch(() => null);
    if (!payload || !['ahead', 'identical'].includes(payload.status)
      || String(payload.base_commit?.sha ?? '').toLowerCase() !== commit) {
      throw new AuthError('Base commit does not belong to the selected GitHub branch', 409, 'invalid_ticket_base');
    }
    this.cache.set(key, Date.now() + 60 * 60 * 1000);
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
  }
}
