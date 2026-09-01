import crypto from 'node:crypto';

const ACCOUNT_COLOURS = Object.freeze([
  '#e85d75', '#4f8cff', '#35a873', '#c779d0', '#e58b35', '#2ea6b7',
  '#7b6ee6', '#9b8b2f', '#d45eae', '#438fca', '#ba6c42', '#5a9d55',
  '#c34f4f', '#6279bd', '#9a63bd', '#348f82', '#c17d25', '#6f8f3d',
  '#e06a97', '#3f9cbd', '#8b73c9', '#d07058', '#4a9b6d', '#a86f2d',
  '#bd5684', '#567fc2', '#7e9238', '#b65cba', '#2f948f', '#ce7040',
]);

export const ACCOUNT_ROLES = Object.freeze([
  'admin',
  'senior translator',
  'translator',
  'trainee-translator',
  'translation-editor',
]);

export const RECOVERY_STATUSES = Object.freeze([
  'setup_required',
  'pending_confirmation',
  'active',
  'admin_authorization_required',
  'issuance_authorized',
]);

export class AuthError extends Error {
  constructor(message, status = 400, code = 'auth_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function normaliseDisplayName(displayName) {
  return String(displayName ?? '').trim().normalize('NFKC');
}

export function displayNameKey(displayName) {
  return normaliseDisplayName(displayName).toLowerCase();
}

export function validateDisplayName(displayName) {
  const name = normaliseDisplayName(displayName);
  if (name.length < 2 || name.length > 64 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new AuthError('Display name must contain 2 to 64 printable characters');
  }
  return name;
}

export function validatePassword(password) {
  const value = String(password ?? '');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (value.length < 12 || value.length > 256 || bytes > 1024 || /[\u0000\r\n]/u.test(value)) {
    throw new AuthError('Password must contain 12 to 256 characters without line breaks', 400, 'invalid_password');
  }
  return value;
}

export function normaliseRoles(value, fallback = ['translator']) {
  const source = Array.isArray(value) ? value : value ? [value] : fallback;
  const roles = [...new Set(source.map((item) => {
    const role = String(item).trim();
    return role === 'senior-translator' ? 'senior translator' : role;
  }).filter(Boolean))];
  if (roles.length === 0 || roles.some((role) => !ACCOUNT_ROLES.includes(role))) {
    throw new AuthError(`Roles must be selected from: ${ACCOUNT_ROLES.join(', ')}`, 400, 'invalid_roles');
  }
  return ACCOUNT_ROLES.filter((role) => roles.includes(role));
}

export function publicUser(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    roles: [...user.roles],
    enabled: user.enabled !== false,
    passwordSet: Boolean(user.passwordVerifier),
    temporaryPassword: user.temporaryPassword === true,
    recoveryStatus: RECOVERY_STATUSES.includes(user.recoveryStatus)
      ? user.recoveryStatus
      : 'setup_required',
    avatarBase64: String(user.avatarBase64 ?? ''),
  };
}

function accountColour(userId) {
  const digest = crypto.createHash('sha256').update(String(userId), 'utf8').digest();
  return ACCOUNT_COLOURS[digest.readUInt16BE(0) % ACCOUNT_COLOURS.length];
}

export function isAccountColour(value) {
  return ACCOUNT_COLOURS.includes(value);
}

export function chooseAccountColour(userId, users) {
  const used = new Set(users.map(({ color }) => color).filter((color) => ACCOUNT_COLOURS.includes(color)));
  const start = ACCOUNT_COLOURS.indexOf(accountColour(userId));
  for (let offset = 0; offset < ACCOUNT_COLOURS.length; offset += 1) {
    const color = ACCOUNT_COLOURS[(start + offset) % ACCOUNT_COLOURS.length];
    if (!used.has(color)) return color;
  }
  return accountColour(userId);
}

export function directoryUser(user) {
  return {
    id: user.id,
    displayName: user.displayName,
    color: user.color ?? accountColour(user.id),
    avatarBase64: String(user.avatarBase64 ?? ''),
  };
}

export function publicSession(session, users) {
  const user = users.find(({ id }) => id === session.userId);
  return {
    id: session.id,
    userId: session.userId,
    user: user?.displayName ?? 'Unknown',
    expiresAt: session.expiresAt,
  };
}

export function inviteStatus(invite, now = Date.now()) {
  if (invite.revoked === true) return 'revoked';
  if (invite.uses >= invite.maxUses) return 'exhausted';
  if (!activeByExpiry(invite, now)) return 'expired';
  return 'active';
}

export function publicInvite(invite, now = Date.now()) {
  return {
    id: invite.id,
    roles: [...invite.roles],
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses,
    uses: invite.uses,
    remainingUses: Math.max(0, invite.maxUses - invite.uses),
    status: inviteStatus(invite, now),
  };
}

export function secretCode(prefix = 'EAW') {
  const value = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `${prefix}-${value.slice(0, 6)}-${value.slice(6, 12)}-${value.slice(12, 18)}-${value.slice(18)}`;
}

export function sessionToken() {
  return `eaw_${crypto.randomBytes(32).toString('base64url')}`;
}

export function activeByExpiry(item, now = Date.now()) {
  return Date.parse(item.expiresAt) > now;
}
