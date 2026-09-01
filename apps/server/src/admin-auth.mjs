import crypto from 'node:crypto';
import {
  AuthError, displayNameKey, hashSecret, publicUser,
} from './auth-model.mjs';

const MAX_TRANSIENT_FAILED_LOGIN_KEYS = 1000;

export async function verifyAdminPassword(store, actor, password, source = '') {
  store.requireManager(actor);
  store.requirePermanentPassword(actor);
  store.consumeLoginCapacity(actor.displayName, source);
  const transientKey = hashSecret(displayNameKey(actor.displayName));
  const delay = store.failedLogins.get(transientKey);
  if (delay?.until > Date.now()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, delay.until - Date.now())));
  }
  const user = store.state.users.find((item) => item.id === actor.id);
  const valid = await store.verifyPassword(password, user?.passwordVerifier);
  if (!user || !valid) {
    const failures = Math.min(8, (delay?.failures ?? 0) + 1);
    if (!store.failedLogins.has(transientKey)
      && store.failedLogins.size >= MAX_TRANSIENT_FAILED_LOGIN_KEYS) {
      store.failedLogins.delete(store.failedLogins.keys().next().value);
    }
    store.failedLogins.set(transientKey, {
      failures, until: Date.now() + Math.min(5000, 250 * 2 ** failures),
    });
    throw new AuthError('Invalid display name or password', 401, 'invalid_credentials');
  }
  store.failedLogins.delete(transientKey);
  return publicUser(user);
}

export async function issueBackupToken(store, actor) {
  store.requireAdmin(actor);
  store.requirePermanentPassword(actor);
  const token = `eaw_backup_${crypto.randomBytes(32).toString('base64url')}`;
  store.state.backupTokens = store.state.backupTokens.filter(({ userId }) => userId !== actor.id);
  store.state.backupTokens.push({
    id: crypto.randomUUID(), tokenHash: hashSecret(token), userId: actor.id,
  });
  await store.persist();
  return { token };
}

export function authenticateBackupToken(store, token) {
  if (!token) throw new AuthError('Backup token is required', 401, 'backup_token_required');
  const record = store.state.backupTokens.find(({ tokenHash }) => tokenHash === hashSecret(token));
  const user = record && store.state.users.find(({ id }) => id === record.userId);
  if (!record || !user || user.enabled === false || !user.roles.includes('admin') || user.temporaryPassword) {
    throw new AuthError('Backup token is invalid or revoked', 401, 'invalid_backup_token');
  }
  return publicUser(user);
}
