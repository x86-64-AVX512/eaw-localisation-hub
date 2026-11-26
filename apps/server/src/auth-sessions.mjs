import crypto from 'node:crypto';
import { AuthError, activeByExpiry, hashSecret, sessionToken } from './auth-model.mjs';

const MAX_SESSIONS_PER_USER = 8;
export const ADMIN_SESSION_TTL_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
export const USER_SESSION_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export function issueSession(state, user, now) {
  if (user.enabled === false) throw new AuthError('Account is disabled', 403, 'account_disabled');
  const token = sessionToken();
  state.sessions = state.sessions.filter((session) => activeByExpiry(session, now));
  const ttl = user.roles.includes('admin') ? ADMIN_SESSION_TTL_MILLISECONDS : USER_SESSION_TTL_MILLISECONDS;
  const session = {
    id: crypto.randomUUID(),
    tokenHash: hashSecret(token),
    userId: user.id,
    expiresAt: new Date(now + ttl).toISOString(),
  };
  const existing = state.sessions.filter(({ userId }) => userId === user.id);
  if (existing.length >= MAX_SESSIONS_PER_USER) {
    const remove = new Set(
      existing
        .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
        .slice(0, existing.length - MAX_SESSIONS_PER_USER + 1)
        .map(({ id }) => id),
    );
    state.sessions = state.sessions.filter(({ id }) => !remove.has(id));
  }
  state.sessions.push(session);
  return { token, session };
}

export function requireActiveSession(state, sessionId, now) {
  const session = state.sessions.find(({ id }) => id === sessionId);
  if (!session) throw new AuthError('Session is invalid or revoked', 401, 'invalid_session');
  if (!activeByExpiry(session, now)) throw new AuthError('Session has expired', 401, 'expired_session');
  const user = state.users.find(({ id }) => id === session.userId);
  if (!user) throw new AuthError('Session is invalid or revoked', 401, 'invalid_session');
  if (user.enabled === false) throw new AuthError('Account is disabled', 403, 'account_disabled');
  return { session, user };
}
