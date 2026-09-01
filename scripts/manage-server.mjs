import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { encryptBackup } from '../packages/shared/src/backup-crypto.mjs';

function parseArguments(argv) {
  const options = {
    server: 'http://127.0.0.1:3210',
    token: process.env.EAW_HUB_ADMIN_TOKEN ?? process.env.EAW_HUB_TOKEN ?? '',
    command: null,
    roles: ['translator'],
    uses: 1,
    hours: 72,
    output: null,
    id: null,
    passphrase: process.env.EAW_HUB_BACKUP_PASSPHRASE ?? '',
    unencrypted: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--server') options.server = argv[++index];
    else if (argument === '--token-file') options.token = (awaitRead(argv[++index]));
    else if (argument === '--passphrase-file') options.passphraseFile = path.resolve(argv[++index]);
    else if (argument === '--password-file') options.passwordFile = path.resolve(argv[++index]);
    else if (argument === '--unencrypted') options.unencrypted = true;
    else if (argument === '--role') options.roles = [argv[++index]];
    else if (argument === '--roles') options.roles = argv[++index].split(',').map((role) => role.trim()).filter(Boolean);
    else if (argument === '--uses') options.uses = Number(argv[++index]);
    else if (argument === '--hours') options.hours = Number(argv[++index]);
    else if (argument === '--output') options.output = path.resolve(argv[++index]);
    else if (argument === '--id') options.id = argv[++index];
    else if (!options.command) options.command = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

let deferredTokenFile = null;
function awaitRead(file) {
  deferredTokenFile = path.resolve(file);
  return '';
}

function httpBase(value) {
  const url = new URL(value);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use http(s) or ws(s)');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Refusing to send an administrator token over plaintext HTTP; use HTTPS/WSS');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function request(options, method, route, body = null, binary = false) {
  if (!options.token) throw new Error('Set EAW_HUB_ADMIN_TOKEN or pass --token-file PATH');
  const response = await fetch(`${httpBase(options.server)}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).error; } catch { detail = await response.text(); }
    throw new Error(`${response.status} ${response.statusText}: ${detail}`);
  }
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

const options = parseArguments(process.argv.slice(2));
if (deferredTokenFile) options.token = (await fs.readFile(deferredTokenFile, 'utf8')).trim();
if (options.passphraseFile) options.passphrase = (await fs.readFile(options.passphraseFile, 'utf8')).trimEnd();
if (options.passwordFile) options.temporaryPassword = (await fs.readFile(options.passwordFile, 'utf8')).trimEnd();
if (!options.command || ['help', '--help'].includes(options.command)) {
  console.log('Usage: node scripts/manage-server.mjs COMMAND [--server URL] [--token-file PATH]');
  console.log('Commands: invite, users, invites, sessions, set-roles, authorize-recovery, set-temporary-password, revoke-user, revoke-session, backup');
  console.log('Role options: --roles role,role (or legacy --role role); invite also accepts --uses N --hours N');
  console.log('Account options: --id UUID; temporary password also requires --password-file FILE');
  console.log('Backup options: --output FILE --passphrase-file FILE');
  process.exit(options.command ? 0 : 1);
}

let result;
if (options.command === 'invite') {
  result = await request(options, 'POST', '/api/admin/invites', {
    roles: options.roles,
    maxUses: options.uses,
    expiresInHours: options.hours,
  });
} else if (options.command === 'users') {
  result = await request(options, 'GET', '/api/admin/users');
} else if (options.command === 'invites') {
  result = await request(options, 'GET', '/api/admin/invites');
} else if (options.command === 'sessions') {
  result = await request(options, 'GET', '/api/admin/sessions');
} else if (options.command === 'set-roles') {
  if (!options.id) throw new Error('--id is required');
  result = await request(options, 'PUT', `/api/admin/users/${encodeURIComponent(options.id)}/roles`, {
    roles: options.roles,
  });
} else if (options.command === 'authorize-recovery') {
  if (!options.id) throw new Error('--id is required');
  result = await request(options, 'POST', `/api/admin/users/${encodeURIComponent(options.id)}/recovery-authorize`);
} else if (options.command === 'set-temporary-password') {
  if (!options.id || !options.temporaryPassword) throw new Error('--id and --password-file are required');
  result = await request(options, 'POST', `/api/admin/users/${encodeURIComponent(options.id)}/temporary-password`, {
    temporaryPassword: options.temporaryPassword,
  });
} else if (options.command === 'revoke-user') {
  if (!options.id) throw new Error('--id is required');
  result = await request(options, 'POST', `/api/admin/users/${encodeURIComponent(options.id)}/revoke`);
} else if (options.command === 'revoke-session') {
  if (!options.id) throw new Error('--id is required');
  result = await request(options, 'POST', `/api/admin/sessions/${encodeURIComponent(options.id)}/revoke`);
} else if (options.command === 'backup') {
  if (!options.passphrase && !options.unencrypted) {
    throw new Error('Set EAW_HUB_BACKUP_PASSPHRASE, use --passphrase-file, or explicitly pass --unencrypted');
  }
  const extension = options.unencrypted ? '.eawhub.gz' : '.eawhub.enc';
  const output = options.output ?? path.resolve(`eaw-hub-${new Date().toISOString().replaceAll(':', '-')}${extension}`);
  const downloaded = await request(options, 'GET', '/api/admin/backup', null, true);
  const bundle = options.unencrypted ? downloaded : await encryptBackup(downloaded, options.passphrase);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, bundle);
  result = { backup: output, bytes: bundle.length };
} else {
  throw new Error(`Unknown command: ${options.command}`);
}
console.log(JSON.stringify(result, null, 2));
