import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthStore } from '../apps/server/src/auth.mjs';

function user(id, roles, enabled = true) {
  return {
    id, displayName: id, roles, enabled, passwordVerifier: {}, temporaryPassword: false,
    recoveryStatus: 'setup_required', avatarBase64: '',
  };
}

test('accounts can be disabled, re-enabled, and deleted as separate operations', async () => {
  const store = new AuthStore('unused', async () => {}, 'required');
  const admin = user('admin', ['admin']);
  const translator = user('translator', ['translator']);
  store.state.users.push(admin, translator);
  store.state.sessions.push({ id: 'session', userId: translator.id, tokenHash: 'x', expiresAt: '2999-01-01T00:00:00.000Z' });

  const disabled = await store.setUserEnabled(admin, translator.id, false);
  assert.equal(disabled.enabled, false);
  assert.equal(store.state.users.length, 2);
  assert.equal(store.state.sessions.length, 0);
  assert.equal((await store.setUserEnabled(admin, translator.id, true)).enabled, true);
  await store.deleteUser(admin, translator.id);
  assert.equal(store.state.users.some(({ id }) => id === translator.id), false);
});

test('senior translators can manage peers and senior invitations but not administrators or themselves', async () => {
  let now = Date.parse('2026-08-31T00:00:00.000Z');
  const store = new AuthStore('unused', async () => {}, 'required', { now: () => now });
  const admin = user('admin', ['admin']);
  const senior = user('senior', ['senior translator']);
  const peer = user('peer', ['translator']);
  store.state.users.push(admin, senior, peer);

  await store.updateRoles(senior, peer.id, ['senior translator', 'translator']);
  assert.deepEqual(peer.roles, ['senior translator', 'translator']);
  await assert.rejects(store.updateRoles(senior, admin.id, ['translator']), { code: 'administrator_protected' });
  await assert.rejects(store.updateRoles(senior, senior.id, ['translator']), { code: 'self_management_forbidden' });
  await assert.rejects(store.createInvite(senior, { roles: ['admin'] }), { code: 'administrator_role_forbidden' });

  const created = await store.createInvite(senior, {
    roles: ['senior translator', 'translator'], maxUses: 3, expiresInHours: 1,
  });
  assert.deepEqual(created.invite.roles, ['senior translator', 'translator']);
  assert.equal(created.invite.remainingUses, 3);
  assert.equal(created.invite.status, 'active');
  const revoked = await store.revokeInvite(senior, created.invite.id);
  assert.equal(revoked.status, 'revoked');
  assert.equal(store.listInvites(senior)[0].remainingUses, 3);
  await store.deleteInviteRecord(senior, created.invite.id);
  assert.deepEqual(store.listInvites(senior), []);

  now += 2 * 60 * 60 * 1000;
});
