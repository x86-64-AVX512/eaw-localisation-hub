import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';

export const REVIEW_SESSION_CLOSED = 4003;
export const REVIEW_LOGIN_REQUIRED = 'Сессия Hub недействительна. Войдите заново в настройках Desktop Agent.';

export function isSessionRejected(code, reason) {
  return code === 1008 && /^(?:Session (?:is invalid or revoked|has expired|revoked|logged out)|Authentication (?:token is required|failed)|Account (?:is disabled|disabled|deleted)|Password (?:changed|recovered)|Temporary password issued|A permanent password must be set before collaboration)$/u.test(reason);
}

export async function readWindowsAgentToken(server) {
  const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
  const command = `
    $ErrorActionPreference = 'Stop'
    . (Join-Path (Get-Location) 'credential-store.ps1')
    $target = Get-EawHubCredentialTarget -Server $env:EAW_HUB_CREDENTIAL_SERVER -Kind 'AgentToken'
    $credential = Get-EawHubCredential -Target $target
    if ($credential) { [Console]::Write($credential.Secret) }
  `;
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], {
    cwd: scripts, windowsHide: true, timeout: 8000, maxBuffer: 8192,
    env: { ...process.env, EAW_HUB_CREDENTIAL_SERVER: server },
  });
  return stdout.trim();
}

export function watchAgentSession(hub) {
  if (hub.sessionSocket || hub.sessionWatchUnsupported || !hub.options.token || hub.closing) return;
  const token = hub.options.token;
  const url = new URL(hub.options.server);
  url.searchParams.set('watchSession', '1');
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 8000, maxPayload: 1024,
  });
  hub.sessionSocket = socket;
  let waitingForPong = false;
  socket.on('pong', () => { waitingForPong = false; });
  socket.on('error', () => {});
  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (waitingForPong) socket.terminate();
    else { waitingForPong = true; socket.ping(); }
  }, 15_000);
  heartbeat.unref();
  socket.once('close', (code, bytes) => {
    clearInterval(heartbeat);
    if (hub.sessionSocket !== socket) return;
    hub.sessionSocket = null;
    const reason = bytes.toString('utf8');
    if (isSessionRejected(code, reason)) hub.rejectSession(token);
    if (code === 1008 && reason === 'Missing or invalid document id') hub.sessionWatchUnsupported = true;
  });
}
