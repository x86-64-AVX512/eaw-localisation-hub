import {
  RECOVERY_STATUSES, activeByExpiry, chooseAccountColour, isAccountColour,
  normaliseDisplayName, normaliseRoles,
} from './auth-model.mjs';
import { normaliseAvatarBase64 } from './avatar.mjs';

function safeAvatar(value) {
  try { return normaliseAvatarBase64(value, { optional: true }); } catch { return ''; }
}

export function migrateAuthState(loaded, {
  now, adminSessionTtl, userSessionTtl,
}) {
  if (![1, 2, 3, 4, 5, 6].includes(loaded.schema)) throw new Error(`Unsupported auth schema: ${loaded.schema}`);
  const users = (Array.isArray(loaded.users) ? loaded.users : [])
    .filter((user) => !user.revokedAt)
    .map((user) => ({
      id: String(user.id),
      displayName: normaliseDisplayName(user.displayName),
      roles: normaliseRoles(user.roles ?? user.role),
      enabled: user.enabled !== false,
      passwordVerifier: user.passwordVerifier ?? null,
      temporaryPassword: loaded.schema >= 3 && user.temporaryPassword === true,
      color: isAccountColour(user.color) ? user.color : null,
      avatarBase64: safeAvatar(user.avatarBase64),
      recoveryStatus: loaded.schema >= 3 && RECOVERY_STATUSES.includes(user.recoveryStatus)
        ? user.recoveryStatus : 'setup_required',
      recoveryCodeHash: loaded.schema >= 3 && /^[0-9a-f]{64}$/u.test(String(user.recoveryCodeHash ?? ''))
        ? String(user.recoveryCodeHash) : null,
      recoveryIssueKind: loaded.schema >= 3 && user.recoveryIssueKind === 'replacement'
        ? 'replacement' : 'setup',
      trainingProgress: Object.fromEntries(Object.entries(user.trainingProgress ?? {})
        .filter(([id, revision]) => /^[a-z0-9-]{1,64}$/u.test(id)
          && Number.isInteger(Number(revision)) && Number(revision) > 0)
        .map(([id, revision]) => [id, Number(revision)])),
    })).filter((user) => user.displayName && (loaded.schema !== 1 || user.id));
  const assignedUsers = [];
  for (const user of users) {
    if (user.recoveryStatus === 'pending_confirmation') {
      user.recoveryStatus = user.recoveryIssueKind === 'replacement'
        ? 'issuance_authorized' : 'setup_required';
      user.recoveryCodeHash = null;
    }
    if (user.recoveryStatus === 'active' && !user.recoveryCodeHash) user.recoveryStatus = 'setup_required';
    if (user.recoveryStatus !== 'active') user.recoveryCodeHash = null;
    if (!user.color || assignedUsers.some(({ color }) => color === user.color)) {
      user.color = chooseAccountColour(user.id, assignedUsers);
    }
    assignedUsers.push(user);
  }
  const userIds = new Set(users.map(({ id }) => id));
  return {
    schema: 6,
    users,
    invites: (Array.isArray(loaded.invites) ? loaded.invites : [])
      .filter((invite) => /^[0-9a-f]{64}$/u.test(String(invite.codeHash ?? '')))
      .map((invite) => ({
        id: String(invite.id), codeHash: String(invite.codeHash),
        roles: normaliseRoles(invite.roles ?? invite.role), expiresAt: String(invite.expiresAt),
        maxUses: Number(invite.maxUses), uses: Number(invite.uses),
        bootstrap: invite.bootstrap === true || invite.createdBy === 'bootstrap',
        revoked: invite.revoked === true || Boolean(invite.revokedAt),
      })),
    sessions: (Array.isArray(loaded.sessions) ? loaded.sessions : [])
      .filter((session) => !session.revokedAt && userIds.has(session.userId)
        && users.find(({ id }) => id === session.userId)?.enabled !== false)
      .map((session) => {
        const user = users.find(({ id }) => id === session.userId);
        const fallbackTtl = user?.roles.includes('admin') ? adminSessionTtl : userSessionTtl;
        const parsedExpiry = Date.parse(session.expiresAt);
        return {
          id: String(session.id), tokenHash: String(session.tokenHash), userId: String(session.userId),
          expiresAt: Number.isFinite(parsedExpiry)
            ? new Date(parsedExpiry).toISOString() : new Date(now() + fallbackTtl).toISOString(),
        };
      }).filter((session) => activeByExpiry(session, now())),
    backupTokens: (loaded.schema >= 4 && Array.isArray(loaded.backupTokens) ? loaded.backupTokens : [])
      .filter((token) => userIds.has(token.userId) && /^[0-9a-f]{64}$/u.test(String(token.tokenHash ?? '')))
      .map((token) => ({ id: String(token.id), tokenHash: String(token.tokenHash), userId: String(token.userId) })),
  };
}
