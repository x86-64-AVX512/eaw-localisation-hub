import crypto from 'node:crypto';
import { AuthError, hashSecret } from './auth-model.mjs';

const SESSION_TTL_MILLISECONDS = 10 * 60 * 1000;
const FRESH_AUTH_MILLISECONDS = 2 * 60 * 1000;
const MAX_SESSIONS = 64;

export class AdminSessionStore {
  constructor(authStore, now = Date.now) {
    this.authStore = authStore;
    this.now = now;
    this.sessions = new Map();
  }

  prune() {
    const now = Number(this.now());
    for (const [tokenHash, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(tokenHash);
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
  }

  issue(actor) {
    this.prune();
    const token = `eaw_management_${crypto.randomBytes(32).toString('base64url')}`;
    const issuedAt = Number(this.now());
    const session = {
      userId: actor.id,
      parentSessionId: actor.sessionId,
      issuedAt,
      expiresAt: issuedAt + SESSION_TTL_MILLISECONDS,
    };
    this.sessions.set(hashSecret(token), session);
    return {
      token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      freshUntil: new Date(issuedAt + FRESH_AUTH_MILLISECONDS).toISOString(),
    };
  }

  async authenticate(token, { fresh = false } = {}) {
    this.prune();
    const tokenHash = hashSecret(String(token ?? ''));
    const session = this.sessions.get(tokenHash);
    if (!session) throw new AuthError('Management session is invalid or expired', 401, 'invalid_management_session');
    if (fresh && Number(this.now()) - session.issuedAt > FRESH_AUTH_MILLISECONDS) {
      throw new AuthError('Enter the account password again', 401, 'management_reauthentication_required');
    }
    try {
      const actor = await this.authStore.authenticateSessionId(session.parentSessionId);
      this.authStore.requirePermanentPassword(actor);
      this.authStore.requireManager(actor);
      return actor;
    } catch (error) {
      this.sessions.delete(tokenHash);
      throw error;
    }
  }

  revoke(token) {
    if (token) this.sessions.delete(hashSecret(token));
  }
}
