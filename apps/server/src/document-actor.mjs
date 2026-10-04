import { AuthError } from './auth.mjs';

// Socket identities are connection snapshots. Role changes must take effect even
// while a room is loading or an already queued CRDT validation is still running.
export function currentDocumentActor(authStore, identity) {
  if (!authStore?.required || !authStore.state?.users) return identity;
  const user = authStore.state.users.find((user) => user.id === identity?.id);
  if (!user || user.enabled === false) throw new AuthError('Account access was revoked', 403, 'account_disabled');
  return { ...identity, roles: user.roles };
}
