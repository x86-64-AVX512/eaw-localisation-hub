import {
  AuthError,
  displayNameKey,
  publicSession,
  publicUser,
} from './auth-model.mjs';
import { generateRecoveryCode } from './recovery-code.mjs';

function userForActor(store, actor) {
  const user = store.state.users.find(({ id }) => id === actor.id);
  if (!user) throw new AuthError('User was not found', 404, 'not_found');
  return user;
}

export async function issueRecoveryCode(store, actor) {
  const user = userForActor(store, actor);
  if (!['setup_required', 'issuance_authorized'].includes(user.recoveryStatus)) {
    throw new AuthError('A recovery code cannot be issued in the current state', 409, 'recovery_not_authorized');
  }
  const code = generateRecoveryCode();
  user.recoveryIssueKind = user.recoveryStatus === 'issuance_authorized' ? 'replacement' : 'setup';
  user.recoveryCodeHash = store.recoveryCodes.hash(code);
  user.recoveryStatus = 'pending_confirmation';
  await store.persist();
  return { code, user: publicUser(user) };
}

export async function confirmRecoveryCode(store, actor, code) {
  const user = userForActor(store, actor);
  if (user.recoveryStatus !== 'pending_confirmation'
    || !store.recoveryCodes.matches(code, user.recoveryCodeHash)) {
    throw new AuthError('Recovery code confirmation is invalid', 409, 'invalid_recovery_confirmation');
  }
  user.recoveryStatus = 'active';
  user.recoveryIssueKind = 'setup';
  await store.persist();
  return publicUser(user);
}

export async function discardPendingRecoveryCode(store, actor) {
  const user = userForActor(store, actor);
  if (user.recoveryStatus === 'pending_confirmation') {
    user.recoveryStatus = user.recoveryIssueKind === 'replacement'
      ? 'issuance_authorized'
      : 'setup_required';
    user.recoveryCodeHash = null;
    await store.persist();
  }
  return publicUser(user);
}

export async function recoverPassword(store, displayName, code, newPassword, source = '') {
  const key = displayNameKey(displayName);
  const user = store.state.users.find((item) => displayNameKey(item.displayName) === key);
  if (!user || user.enabled === false || user.recoveryStatus !== 'active'
    || !store.recoveryCodes.matches(code, user.recoveryCodeHash)) {
    throw new AuthError('Display name or recovery code is invalid', 401, 'invalid_recovery_code');
  }
  const expectedHash = user.recoveryCodeHash;
  const passwordVerifier = await store.hashPassword(newPassword);
  if (user.recoveryStatus !== 'active' || user.recoveryCodeHash !== expectedHash) {
    throw new AuthError('Recovery code is no longer active', 409, 'recovery_race');
  }
  user.passwordVerifier = passwordVerifier;
  user.temporaryPassword = false;
  user.recoveryCodeHash = null;
  user.recoveryStatus = 'admin_authorization_required';
  user.recoveryIssueKind = 'replacement';
  store.state.sessions = store.state.sessions.filter((session) => session.userId !== user.id);
  store.state.backupTokens = store.state.backupTokens.filter((token) => token.userId !== user.id);
  if (user.roles.includes('admin')) {
    store.state.invites = store.state.invites.filter((invite) => !invite.bootstrap);
  }
  const issued = store.issueSession(user);
  await store.persist();
  if (user.roles.includes('admin')) await store.removeBootstrapInvite();
  return { token: issued.token, user: publicUser(user), session: publicSession(issued.session, store.state.users) };
}

export async function authorizeRecoveryCode(store, actor, userId) {
  const user = store.state.users.find(({ id }) => id === userId);
  store.assertCanManageUser(actor, user);
  user.recoveryCodeHash = null;
  user.recoveryStatus = 'issuance_authorized';
  user.recoveryIssueKind = 'replacement';
  await store.persist();
  return publicUser(user);
}

export async function setTemporaryPassword(store, actor, userId, temporaryPassword) {
  const user = store.state.users.find(({ id }) => id === userId);
  store.assertCanManageUser(actor, user);
  if (actor.id === userId) {
    throw new AuthError('Use the normal password-change flow for the current account', 409, 'self_temporary_password');
  }
  const passwordVerifier = await store.hashPassword(temporaryPassword);
  if (!store.state.users.includes(user)) throw new AuthError('User is no longer available', 409, 'user_race');
  user.passwordVerifier = passwordVerifier;
  user.temporaryPassword = true;
  user.recoveryCodeHash = null;
  user.recoveryStatus = 'admin_authorization_required';
  user.recoveryIssueKind = 'replacement';
  store.state.sessions = store.state.sessions.filter((session) => session.userId !== user.id);
  store.state.backupTokens = store.state.backupTokens.filter((token) => token.userId !== user.id);
  await store.persist();
  return publicUser(user);
}
