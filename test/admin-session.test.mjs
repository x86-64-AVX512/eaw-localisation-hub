import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminSessionStore } from '../apps/server/src/admin-session.mjs';

test('management sessions are memory-only, short-lived, and require freshness for sensitive actions', async () => {
  let now = 1_000_000;
  const actor = { id: 'admin-1', displayName: 'Admin', roles: ['admin'], sessionId: 'parent-1' };
  const authStore = {
    authenticateSessionId: async (sessionId) => {
      assert.equal(sessionId, 'parent-1');
      return actor;
    },
    requirePermanentPassword() {},
    requireManager() {},
  };
  const sessions = new AdminSessionStore(authStore, () => now);
  const issued = sessions.issue(actor);
  assert.match(issued.token, /^eaw_management_/u);
  assert.equal((await sessions.authenticate(issued.token, { fresh: true })).id, actor.id);

  now += 2 * 60 * 1000 + 1;
  await assert.rejects(
    sessions.authenticate(issued.token, { fresh: true }),
    (error) => error.code === 'management_reauthentication_required',
  );
  assert.equal((await sessions.authenticate(issued.token)).id, actor.id);

  now += 8 * 60 * 1000;
  await assert.rejects(
    sessions.authenticate(issued.token),
    (error) => error.code === 'invalid_management_session',
  );
});
