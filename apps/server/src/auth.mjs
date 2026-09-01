import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ACCOUNT_ROLES,
  AuthError,
  activeByExpiry,
  chooseAccountColour,
  directoryUser,
  displayNameKey,
  hashSecret,
  normaliseRoles,
  publicInvite,
  publicSession,
  publicUser,
  secretCode,
  sessionToken,
  validateDisplayName,
  validatePassword,
} from './auth-model.mjs';
import { normaliseAvatarBase64 } from './avatar.mjs';
import { migrateAuthState } from './auth-state.mjs';
import {
  authorizeRecoveryCode,
  confirmRecoveryCode,
  discardPendingRecoveryCode,
  issueRecoveryCode,
  recoverPassword,
  setTemporaryPassword,
} from './auth-recovery.mjs';
import { generateRecoveryCode, RecoveryCodeHasher } from './recovery-code.mjs';
import {
  authenticateBackupToken, issueBackupToken, verifyAdminPassword,
} from './admin-auth.mjs';
import {
  assertCanAssignRoles,
  assertCanCreateInvite,
  assertCanManageInvite,
  assertCanManageUser,
  requireManager,
} from './management-policy.mjs';

export { ACCOUNT_ROLES, AuthError };
const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_PARAMETERS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
const PASSWORD_KEY_BYTES = 32;
const MAX_PASSWORD_JOBS = 8;
const MAX_TRANSIENT_FAILED_LOGIN_KEYS = 1000;
const MAX_TRANSIENT_LOGIN_BUCKETS = 1000;
const LOGIN_BUCKET_IDLE_MILLISECONDS = 15 * 60 * 1000;
const ACCOUNT_LOGIN_BURST = 6;
const ACCOUNT_LOGIN_REFILL_PER_SECOND = 1 / 10;
const SOURCE_LOGIN_BURST = 12;
const SOURCE_LOGIN_REFILL_PER_SECOND = 2;
const MAX_SESSIONS_PER_USER = 8;
const ADMIN_SESSION_TTL_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const USER_SESSION_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

export class AuthStore {
  constructor(dataDirectory, atomicWrite, mode = 'required', rateLimit = {}) {
    this.mode = mode;
    this.atomicWrite = atomicWrite;
    this.statePath = path.join(dataDirectory, 'auth.json');
    this.bootstrapPath = path.join(dataDirectory, 'bootstrap-invite.txt');
    this.state = { schema: 5, users: [], invites: [], sessions: [], backupTokens: [] };
    this.recoveryCodes = new RecoveryCodeHasher(dataDirectory, atomicWrite);
    this.persistPromise = Promise.resolve();
    this.passwordWorkPromise = Promise.resolve();
    this.pendingPasswordJobs = 0;
    this.failedLogins = new Map();
    this.dummyPasswordVerifier = null;
    this.now = rateLimit.now ?? Date.now;
    this.loginSourceKey = crypto.randomBytes(32);
    this.loginBuckets = {
      accounts: new Map(),
      sources: new Map(),
      accountCapacity: Number(rateLimit.accountCapacity ?? ACCOUNT_LOGIN_BURST),
      accountRefillPerSecond: Number(rateLimit.accountRefillPerSecond ?? ACCOUNT_LOGIN_REFILL_PER_SECOND),
      sourceCapacity: Number(rateLimit.sourceCapacity ?? SOURCE_LOGIN_BURST),
      sourceRefillPerSecond: Number(rateLimit.sourceRefillPerSecond ?? SOURCE_LOGIN_REFILL_PER_SECOND),
    };
  }

  get required() {
    return this.mode === 'required';
  }

  migrateState(loaded) {
    return migrateAuthState(loaded, {
      now: this.now,
      adminSessionTtl: ADMIN_SESSION_TTL_MILLISECONDS,
      userSessionTtl: USER_SESSION_TTL_MILLISECONDS,
    });
  }

  async initialise() {
    await this.recoveryCodes.initialise();
    try {
      this.state = this.migrateState(JSON.parse(await fs.readFile(this.statePath, 'utf8')));
      await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!this.required) return null;
    this.dummyPasswordVerifier = await this.hashPassword(secretCode('DUMMY-PASSWORD'));
    const passwordAdminExists = this.state.users.some(
      (user) => user.enabled !== false && user.passwordVerifier && user.roles.includes('admin'),
    );
    if (passwordAdminExists) {
      const inviteCount = this.state.invites.length;
      this.state.invites = this.state.invites.filter((invite) => !invite.bootstrap);
      if (this.state.invites.length !== inviteCount) await this.persist();
      await fs.rm(this.bootstrapPath, { force: true });
      return null;
    }

    try {
      const existing = (await fs.readFile(this.bootstrapPath, 'utf8')).trim();
      const existingHash = hashSecret(existing.toUpperCase());
      const active = this.state.invites.some((invite) => invite.codeHash === existingHash
        && invite.bootstrap && invite.uses < invite.maxUses && activeByExpiry(invite));
      if (existing && active) return existing;
      await fs.rm(this.bootstrapPath, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const code = secretCode();
    this.state.invites.push({
      id: crypto.randomUUID(),
      codeHash: hashSecret(code),
      roles: ['admin'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      maxUses: 1,
      uses: 0,
      bootstrap: true,
      revoked: false,
    });
    await this.persist();
    await fs.writeFile(this.bootstrapPath, `${code}\n`, { encoding: 'utf8', mode: 0o600 });
    return code;
  }

  async persist() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const write = this.persistPromise
      .catch(() => {})
      .then(() => this.atomicWrite(this.statePath, snapshot));
    this.persistPromise = write;
    await write;
  }

  async flush() {
    await this.persistPromise;
    await this.passwordWorkPromise.catch(() => {});
  }

  async passwordWork(operation) {
    if (this.pendingPasswordJobs >= MAX_PASSWORD_JOBS) {
      throw new AuthError('Password service is busy; try again shortly', 503, 'password_service_busy');
    }
    this.pendingPasswordJobs += 1;
    const work = this.passwordWorkPromise.catch(() => {}).then(operation);
    this.passwordWorkPromise = work;
    try {
      return await work;
    } finally {
      this.pendingPasswordJobs -= 1;
    }
  }

  consumeLoginBucket(buckets, key, capacity, refillPerSecond) {
    const now = Number(this.now());
    let bucket = buckets.get(key);
    if (!bucket) bucket = { tokens: capacity, updatedAt: now, lastUsedAt: now };
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.updatedAt = now;
    bucket.lastUsedAt = now;
    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      throw new AuthError('Too many login attempts; try again shortly', 429, 'login_rate_limited');
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    if (buckets.size > MAX_TRANSIENT_LOGIN_BUCKETS) {
      for (const [candidate, value] of buckets) {
        if (now - value.lastUsedAt >= LOGIN_BUCKET_IDLE_MILLISECONDS || buckets.size > MAX_TRANSIENT_LOGIN_BUCKETS) {
          buckets.delete(candidate);
        }
        if (buckets.size <= MAX_TRANSIENT_LOGIN_BUCKETS) break;
      }
    }
  }

  consumeLoginCapacity(displayName, source) {
    const accountKey = hashSecret(displayNameKey(displayName));
    const sourceKey = crypto.createHmac('sha256', this.loginSourceKey)
      .update(String(source || 'unknown'), 'utf8')
      .digest('hex');
    this.consumeLoginBucket(
      this.loginBuckets.accounts,
      accountKey,
      this.loginBuckets.accountCapacity,
      this.loginBuckets.accountRefillPerSecond,
    );
    this.consumeLoginBucket(
      this.loginBuckets.sources,
      sourceKey,
      this.loginBuckets.sourceCapacity,
      this.loginBuckets.sourceRefillPerSecond,
    );
  }

  async hashPassword(password) {
    const value = validatePassword(password);
    return this.passwordWork(async () => {
      const salt = crypto.randomBytes(16);
      const derived = await scryptAsync(value, salt, PASSWORD_KEY_BYTES, SCRYPT_PARAMETERS);
      return {
        algorithm: 'scrypt',
        N: SCRYPT_PARAMETERS.N,
        r: SCRYPT_PARAMETERS.r,
        p: SCRYPT_PARAMETERS.p,
        salt: salt.toString('base64url'),
        hash: Buffer.from(derived).toString('base64url'),
      };
    });
  }

  async verifyPassword(password, verifier) {
    const value = String(password ?? '');
    const supported = verifier?.algorithm === 'scrypt'
      && Number(verifier.N) === SCRYPT_PARAMETERS.N
      && Number(verifier.r) === SCRYPT_PARAMETERS.r
      && Number(verifier.p) === SCRYPT_PARAMETERS.p
      && typeof verifier.salt === 'string'
      && Buffer.from(verifier.salt, 'base64url').length === 16
      && typeof verifier.hash === 'string'
      && Buffer.from(verifier.hash, 'base64url').length === PASSWORD_KEY_BYTES;
    const selected = supported ? verifier : this.dummyPasswordVerifier;
    if (!selected) return false;
    try {
      return await this.passwordWork(async () => {
        const salt = Buffer.from(selected.salt, 'base64url');
        const expected = Buffer.from(selected.hash, 'base64url');
        const actual = Buffer.from(await scryptAsync(value, salt, expected.length, {
          N: Number(selected.N), r: Number(selected.r), p: Number(selected.p), maxmem: SCRYPT_PARAMETERS.maxmem,
        }));
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      return false;
    }
  }

  issueSession(user) {
    if (user.enabled === false) throw new AuthError('Account is disabled', 403, 'account_disabled');
    const token = sessionToken();
    const now = this.now();
    this.state.sessions = this.state.sessions.filter((session) => activeByExpiry(session, now));
    const ttl = user.roles.includes('admin')
      ? ADMIN_SESSION_TTL_MILLISECONDS
      : USER_SESSION_TTL_MILLISECONDS;
    const session = {
      id: crypto.randomUUID(),
      tokenHash: hashSecret(token),
      userId: user.id,
      expiresAt: new Date(now + ttl).toISOString(),
    };
    const existing = this.state.sessions.filter(({ userId }) => userId === user.id);
    if (existing.length >= MAX_SESSIONS_PER_USER) {
      const remove = new Set(existing
        .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
        .slice(0, existing.length - MAX_SESSIONS_PER_USER + 1)
        .map(({ id }) => id));
      this.state.sessions = this.state.sessions.filter(({ id }) => !remove.has(id));
    }
    this.state.sessions.push(session);
    return { token, session };
  }

  async authenticate(token) {
    if (!this.required) {
      return { id: 'anonymous', displayName: null, roles: ['translator'], passwordSet: false, sessionId: null };
    }
    if (!token) throw new AuthError('Authentication token is required', 401, 'token_required');
    const tokenHash = hashSecret(token);
    const session = this.state.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session) throw new AuthError('Session is invalid or revoked', 401, 'invalid_session');
    return this.authenticateSessionId(session.id);
  }

  async authenticateSessionId(sessionId) {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session) throw new AuthError('Session is invalid or revoked', 401, 'invalid_session');
    if (!activeByExpiry(session, this.now())) {
      this.state.sessions = this.state.sessions.filter(({ id }) => id !== session.id);
      await this.persist();
      throw new AuthError('Session has expired', 401, 'expired_session');
    }
    const user = this.state.users.find(({ id }) => id === session.userId);
    if (!user) throw new AuthError('Session is invalid or revoked', 401, 'invalid_session');
    if (user.enabled === false) throw new AuthError('Account is disabled', 403, 'account_disabled');
    return { ...publicUser(user), sessionId: session.id };
  }

  async redeem(code, displayName, password) {
    if (!this.required) throw new AuthError('Authentication is disabled on this server', 409, 'auth_disabled');
    const name = validateDisplayName(displayName);
    const key = displayNameKey(name);
    if (this.state.users.some((user) => displayNameKey(user.displayName) === key)) {
      throw new AuthError('This display name is already registered', 409, 'name_taken');
    }
    const codeHash = hashSecret(String(code ?? '').trim().toUpperCase());
    const invite = this.state.invites.find((item) => item.codeHash === codeHash);
    if (!invite || invite.revoked === true || invite.uses >= invite.maxUses) {
      throw new AuthError('Invitation is invalid or already used', 401, 'invalid_invite');
    }
    if (!activeByExpiry(invite)) throw new AuthError('Invitation has expired', 401, 'expired_invite');

    const passwordVerifier = await this.hashPassword(password);
    if (this.state.users.some((user) => displayNameKey(user.displayName) === key)
      || !this.state.invites.includes(invite)
      || invite.uses >= invite.maxUses
      || !activeByExpiry(invite)) {
      throw new AuthError('Invitation or display name is no longer available', 409, 'registration_race');
    }
    const user = {
      id: crypto.randomUUID(),
      displayName: name,
      roles: [...invite.roles],
      enabled: true,
      passwordVerifier,
      temporaryPassword: false,
      recoveryStatus: 'pending_confirmation',
      recoveryIssueKind: 'setup',
    };
    const recoveryCode = generateRecoveryCode();
    user.recoveryCodeHash = this.recoveryCodes.hash(recoveryCode);
    user.color = chooseAccountColour(user.id, this.state.users);
    const issued = this.issueSession(user);
    invite.uses += 1;
    this.state.users.push(user);
    await this.persist();
    if (invite.bootstrap) await fs.rm(this.bootstrapPath, { force: true });
    return {
      token: issued.token,
      user: publicUser(user),
      session: publicSession(issued.session, this.state.users),
      recoveryCode,
    };
  }

  async login(displayName, password, source = '') {
    if (!this.required) throw new AuthError('Authentication is disabled on this server', 409, 'auth_disabled');
    this.consumeLoginCapacity(displayName, source);
    const key = displayNameKey(displayName);
    const transientKey = hashSecret(key);
    const delay = this.failedLogins.get(transientKey);
    if (delay?.until > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(3000, delay.until - Date.now())));
    }
    const user = this.state.users.find((item) => displayNameKey(item.displayName) === key);
    const valid = await this.verifyPassword(password, user?.passwordVerifier);
    if (!user || user.enabled === false || !valid) {
      const failures = Math.min(8, (delay?.failures ?? 0) + 1);
      if (!this.failedLogins.has(transientKey) && this.failedLogins.size >= MAX_TRANSIENT_FAILED_LOGIN_KEYS) {
        this.failedLogins.delete(this.failedLogins.keys().next().value);
      }
      this.failedLogins.set(transientKey, { failures, until: Date.now() + Math.min(5000, 250 * 2 ** failures) });
      throw new AuthError('Invalid display name or password', 401, 'invalid_credentials');
    }
    this.failedLogins.delete(transientKey);
    const issued = this.issueSession(user);
    await this.persist();
    return { token: issued.token, user: publicUser(user), session: publicSession(issued.session, this.state.users) };
  }

  async verifyAdminPassword(actor, password, source = '') {
    return verifyAdminPassword(this, actor, password, source);
  }

  async issueBackupToken(actor) {
    return issueBackupToken(this, actor);
  }

  authenticateBackupToken(token) {
    return authenticateBackupToken(this, token);
  }

  requireAdmin(user) {
    if (!user?.roles?.includes('admin')) {
      throw new AuthError('Administrator role is required', 403, 'admin_required');
    }
  }

  requireManager(user) {
    requireManager(user);
  }

  assertCanManageUser(actor, user) {
    assertCanManageUser(actor, user);
  }

  async changePassword(actor, currentPassword, newPassword) {
    const user = this.state.users.find(({ id }) => id === actor.id);
    if (!user || !await this.verifyPassword(currentPassword, user.passwordVerifier)) {
      throw new AuthError('Current password is incorrect', 401, 'invalid_credentials');
    }
    user.passwordVerifier = await this.hashPassword(newPassword);
    user.temporaryPassword = false;
    this.state.sessions = this.state.sessions.filter(
      (session) => session.userId !== user.id || session.id === actor.sessionId,
    );
    this.state.backupTokens = this.state.backupTokens.filter((token) => token.userId !== user.id);
    await this.persist();
    return publicUser(user);
  }

  async issueRecoveryCode(actor) { return issueRecoveryCode(this, actor); }
  async confirmRecoveryCode(actor, code) { return confirmRecoveryCode(this, actor, code); }
  async discardPendingRecoveryCode(actor) { return discardPendingRecoveryCode(this, actor); }
  async recoverPassword(displayName, code, newPassword, source = '') {
    return recoverPassword(this, displayName, code, newPassword, source);
  }
  async authorizeRecoveryCode(actor, userId) { return authorizeRecoveryCode(this, actor, userId); }
  async setTemporaryPassword(actor, userId, password) { return setTemporaryPassword(this, actor, userId, password); }

  async removeBootstrapInvite() { await fs.rm(this.bootstrapPath, { force: true }); }

  requirePermanentPassword(user) {
    if (user?.temporaryPassword) {
      throw new AuthError('A permanent password must be set before collaboration', 403, 'temporary_password_change_required');
    }
  }

  async createInvite(actor, options = {}) {
    const roles = normaliseRoles(options.roles ?? options.role);
    assertCanCreateInvite(actor, roles);
    const expiresInHours = Math.min(24 * 30, Math.max(1, Number(options.expiresInHours ?? 72)));
    const maxUses = Math.min(30, Math.max(1, Number(options.maxUses ?? 1)));
    if (!Number.isInteger(expiresInHours) || !Number.isInteger(maxUses)) {
      throw new AuthError('Invite expiry and max uses must be integers');
    }
    const code = secretCode();
    const invite = {
      id: crypto.randomUUID(),
      codeHash: hashSecret(code),
      roles,
      expiresAt: new Date(this.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
      maxUses,
      uses: 0,
      bootstrap: false,
      revoked: false,
    };
    this.state.invites.push(invite);
    await this.persist();
    return { code, invite: publicInvite(invite, this.now()) };
  }

  listUsers(actor) {
    this.requireManager(actor);
    return this.state.users.map(publicUser);
  }

  directory(actor) {
    if (!this.required) return [];
    if (this.required && !actor?.id) {
      throw new AuthError('Authentication token is required', 401, 'token_required');
    }
    return this.state.users.filter((user) => user.enabled !== false).map(directoryUser);
  }

  findDirectoryUser(actor, userId) {
    if (!this.required) return null;
    if (this.required && !actor?.id) {
      throw new AuthError('Authentication token is required', 401, 'token_required');
    }
    const user = this.state.users.find(({ id }) => id === String(userId ?? ''));
    return user?.enabled !== false ? directoryUser(user) : null;
  }

  listInvites(actor) {
    this.requireManager(actor);
    return this.state.invites.filter((invite) => !invite.bootstrap)
      .map((invite) => publicInvite(invite, this.now()));
  }

  listSessions(actor) {
    this.requireAdmin(actor);
    return this.state.sessions
      .filter((session) => activeByExpiry(session, this.now()))
      .map((session) => publicSession(session, this.state.users));
  }

  async updateRoles(actor, userId, roles) {
    const user = this.state.users.find(({ id }) => id === userId);
    const selected = normaliseRoles(roles);
    assertCanAssignRoles(actor, user, selected);
    user.roles = selected;
    if (!selected.includes('admin')) {
      this.state.backupTokens = this.state.backupTokens.filter(({ userId: ownerId }) => ownerId !== user.id);
    }
    if (user.passwordVerifier && selected.includes('admin')) {
      this.state.invites = this.state.invites.filter((invite) => !invite.bootstrap);
    }
    await this.persist();
    if (user.passwordVerifier && selected.includes('admin')) await fs.rm(this.bootstrapPath, { force: true });
    return publicUser(user);
  }

  async updateAvatar(actor, avatarBase64) {
    if (!this.required || !actor?.id) {
      throw new AuthError('Authentication token is required', 401, 'token_required');
    }
    const user = this.state.users.find(({ id }) => id === actor.id);
    if (!user) throw new AuthError('User was not found', 404, 'not_found');
    try {
      user.avatarBase64 = normaliseAvatarBase64(avatarBase64, { optional: true });
    } catch (error) {
      throw new AuthError(error.message, 400, 'invalid_avatar');
    }
    await this.persist();
    return publicUser(user);
  }

  async setUserEnabled(actor, userId, enabled) {
    const user = this.state.users.find(({ id }) => id === userId);
    assertCanManageUser(actor, user);
    if (actor.id === userId) throw new AuthError('The current account cannot be disabled', 409, 'self_disable_forbidden');
    user.enabled = enabled === true;
    if (!user.enabled) {
      this.state.sessions = this.state.sessions.filter((session) => session.userId !== userId);
      this.state.backupTokens = this.state.backupTokens.filter((token) => token.userId !== userId);
    }
    await this.persist();
    return publicUser(user);
  }

  async deleteUser(actor, userId) {
    const user = this.state.users.find(({ id }) => id === userId);
    assertCanManageUser(actor, user);
    if (actor.id === userId) throw new AuthError('The current account cannot be deleted', 409, 'self_delete_forbidden');
    this.state.users = this.state.users.filter(({ id }) => id !== userId);
    this.state.sessions = this.state.sessions.filter((session) => session.userId !== userId);
    this.state.backupTokens = this.state.backupTokens.filter((token) => token.userId !== userId);
    await this.persist();
    return publicUser(user);
  }

  async revokeInvite(actor, inviteId) {
    const invite = this.state.invites.find(({ id, bootstrap }) => id === inviteId && !bootstrap);
    assertCanManageInvite(actor, invite);
    invite.revoked = true;
    await this.persist();
    return publicInvite(invite, this.now());
  }

  async deleteInviteRecord(actor, inviteId) {
    const invite = this.state.invites.find(({ id, bootstrap }) => id === inviteId && !bootstrap);
    assertCanManageInvite(actor, invite);
    if (publicInvite(invite, this.now()).status === 'active') {
      throw new AuthError('Active invitations must be revoked before deletion', 409, 'active_invite');
    }
    this.state.invites = this.state.invites.filter(({ id }) => id !== inviteId);
    await this.persist();
    return publicInvite(invite, this.now());
  }

  async revokeSession(actor, sessionId) {
    this.requireAdmin(actor);
    const session = this.state.sessions.find(({ id }) => id === sessionId);
    if (!session) throw new AuthError('Session was not found', 404, 'not_found');
    this.state.sessions = this.state.sessions.filter(({ id }) => id !== sessionId);
    await this.persist();
    return publicSession(session, this.state.users);
  }

  async logout(token) {
    if (!token) return;
    const tokenHash = hashSecret(token);
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((item) => item.tokenHash !== tokenHash);
    if (this.state.sessions.length !== before) await this.persist();
  }
}

export function bearerToken(request) {
  const header = String(request.headers.authorization ?? '');
  const match = /^Bearer[ \t]+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}
