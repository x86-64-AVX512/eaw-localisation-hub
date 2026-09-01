import { bearerToken } from './auth.mjs';
import { createBackupBundle } from './backup.mjs';
import { anonymisePersistedHistory } from './document-history.mjs';
import { anonymisePersistedReservationUser } from './room-metadata.mjs';
import { DISPLAY_VERSION } from '../../../packages/shared/src/constants.mjs';

export async function handleAdminHttp(context) {
  const {
    request, response, url, authStore, adminSessions, authenticatedUser,
    authenticatedAdmin, authenticatedBackup, readJsonBody, transientLoginSource,
    sendJson, disconnectAuthenticatedSockets, rooms, dataDirectory, atomicWrite,
    broadcastDirectories, flushRooms,
  } = context;
  const managementPath = url.pathname.startsWith('/api/management/')
    ? url.pathname.slice('/api/management'.length)
    : url.pathname.startsWith('/api/admin/')
      ? url.pathname.slice('/api/admin'.length)
      : null;
  if (!managementPath) return false;
  if (request.method === 'POST' && managementPath === '/session') {
    const actor = await authenticatedUser(request);
    authStore.requireManager(actor);
    const body = await readJsonBody(request);
    await authStore.verifyAdminPassword(actor, body.password, transientLoginSource(request));
    sendJson(response, 201, { ...adminSessions.issue(actor), user: actor });
    return true;
  }
  if (request.method === 'DELETE' && managementPath === '/session') {
    adminSessions.revoke(bearerToken(request));
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (request.method === 'POST' && managementPath === '/backup-token') {
    const actor = await authenticatedAdmin(request, { fresh: true });
    sendJson(response, 201, await authStore.issueBackupToken(actor));
    return true;
  }
  if (request.method === 'POST' && managementPath === '/invites') {
    const actor = await authenticatedAdmin(request, { fresh: true });
    sendJson(response, 201, await authStore.createInvite(actor, await readJsonBody(request)));
    return true;
  }
  if (request.method === 'GET' && managementPath === '/users') {
    const actor = await authenticatedAdmin(request);
    sendJson(response, 200, { users: authStore.listUsers(actor) });
    return true;
  }
  if (request.method === 'GET' && managementPath === '/invites') {
    const actor = await authenticatedAdmin(request);
    sendJson(response, 200, { invites: authStore.listInvites(actor) });
    return true;
  }
  if (request.method === 'GET' && managementPath === '/sessions') {
    const actor = await authenticatedAdmin(request);
    sendJson(response, 200, { sessions: authStore.listSessions(actor) });
    return true;
  }
  let match = /^\/users\/([^/]+)\/(enable|disable)$/.exec(managementPath);
  if (request.method === 'POST' && match) {
    const actor = await authenticatedAdmin(request, { fresh: true });
    const enabled = match[2] === 'enable';
    const user = await authStore.setUserEnabled(actor, decodeURIComponent(match[1]), enabled);
    if (!enabled) {
      await disconnectAuthenticatedSockets((identity) => identity?.id === user.id, 'Account disabled');
    }
    await broadcastDirectories();
    sendJson(response, 200, { user });
    return true;
  }
  match = /^\/users\/([^/]+)(?:\/revoke)?$/.exec(managementPath);
  if ((request.method === 'DELETE' || (request.method === 'POST' && managementPath.endsWith('/revoke'))) && match) {
    const actor = await authenticatedAdmin(request, { fresh: true });
    const user = await authStore.deleteUser(actor, decodeURIComponent(match[1]));
    await disconnectAuthenticatedSockets((identity) => identity?.id === user.id, 'Account deleted');
    const loadedRooms = await Promise.all([...rooms.values()]);
    for (const room of loadedRooms) room.anonymiseUser(user.id);
    await Promise.all(loadedRooms.map((room) => room.flush()));
    await anonymisePersistedReservationUser(dataDirectory, user.id, atomicWrite);
    await anonymisePersistedHistory(dataDirectory, user.id, atomicWrite);
    await broadcastDirectories();
    sendJson(response, 200, { user });
    return true;
  }
  match = /^\/sessions\/([^/]+)\/revoke$/.exec(managementPath);
  if (request.method === 'POST' && match) {
    const actor = await authenticatedAdmin(request, { fresh: true });
    const session = await authStore.revokeSession(actor, decodeURIComponent(match[1]));
    await disconnectAuthenticatedSockets(
      (identity) => identity?.sessionId === session.id, 'Device session revoked',
    );
    sendJson(response, 200, { session });
    return true;
  }
  match = /^\/users\/([^/]+)\/roles$/.exec(managementPath);
  if (request.method === 'PUT' && match) {
    const actor = await authenticatedAdmin(request, { fresh: true });
    const body = await readJsonBody(request);
    sendJson(response, 200, { user: await authStore.updateRoles(actor, decodeURIComponent(match[1]), body.roles) });
    return true;
  }
  match = /^\/users\/([^/]+)\/recovery-authorize$/.exec(managementPath);
  if (request.method === 'POST' && match) {
    const actor = await authenticatedAdmin(request, { fresh: true });
    sendJson(response, 200, { user: await authStore.authorizeRecoveryCode(actor, decodeURIComponent(match[1])) });
    return true;
  }
  match = /^\/users\/([^/]+)\/temporary-password$/.exec(managementPath);
  if (request.method === 'POST' && match) {
    const actor = await authenticatedAdmin(request, { fresh: true });
    const body = await readJsonBody(request);
    const user = await authStore.setTemporaryPassword(actor, decodeURIComponent(match[1]), body.temporaryPassword);
    await disconnectAuthenticatedSockets((identity) => identity?.id === user.id, 'Temporary password issued');
    sendJson(response, 200, { user });
    return true;
  }
  match = /^\/invites\/([^/]+)\/revoke$/.exec(managementPath);
  if (request.method === 'POST' && match) {
    const actor = await authenticatedAdmin(request, { fresh: true });
    const invite = await authStore.revokeInvite(actor, decodeURIComponent(match[1]));
    sendJson(response, 200, { invite });
    return true;
  }
  match = /^\/invites\/([^/]+)$/.exec(managementPath);
  if (request.method === 'DELETE' && match) {
    const actor = await authenticatedAdmin(request, { fresh: true });
    const invite = await authStore.deleteInviteRecord(actor, decodeURIComponent(match[1]));
    sendJson(response, 200, { invite });
    return true;
  }
  if (request.method === 'GET' && managementPath === '/backup') {
    await authenticatedBackup(request);
    await flushRooms();
    const backup = await createBackupBundle(dataDirectory, DISPLAY_VERSION);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    response.writeHead(200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="eaw-hub-${stamp}.eawhub.gz"`,
      'content-length': backup.length,
      'cache-control': 'no-store',
    });
    response.end(backup);
    return true;
  }
  sendJson(response, 404, { error: 'Not found', code: 'not_found' });
  return true;
}
