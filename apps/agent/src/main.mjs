import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DISPLAY_VERSION } from '../../../packages/shared/src/constants.mjs';
import { AgentHub } from './agent-hub.mjs';
import { runGitSync } from './git-executable.mjs';
import { startReviewServer } from './review-server.mjs';
import { registerAgentInstance, unregisterAgentInstance } from './instance-registry.mjs';

function parseArguments(argv) {
  const environmentToken = process.env.EAW_HUB_TOKEN?.trim() ?? '';
  const environmentIpcSecret = process.env.EAW_HUB_IPC_SECRET?.trim() ?? '';
  delete process.env.EAW_HUB_TOKEN;
  delete process.env.EAW_HUB_IPC_SECRET;
  const result = {
    server: 'ws://127.0.0.1:3210',
    pipe: process.env.EAW_HUB_PIPE ?? 'eaw-localisation-hub',
    repo: process.cwd(),
    user: process.env.EAW_HUB_USER ?? os.userInfo().username,
    color: process.env.EAW_HUB_COLOR ?? '#6aa9ff',
    token: environmentToken,
    ipcSecret: environmentIpcSecret,
    pipeExplicit: Boolean(process.env.EAW_HUB_PIPE),
    workspace: null,
    workspaceExplicit: false,
    state: path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'),
      'EaWLocalisationHub',
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--server') result.server = argv[++index];
    else if (argument === '--pipe') result.pipe = argv[++index];
    else if (argument === '--ipc-secret') result.ipcSecret = argv[++index];
    else if (argument === '--repo') result.repo = path.resolve(argv[++index]);
    else if (argument === '--user') result.user = argv[++index];
    else if (argument === '--color') result.color = argv[++index];
    else if (argument === '--token') result.token = argv[++index];
    else if (argument === '--token-file') {
      result.token = fs.readFileSync(path.resolve(argv[++index]), 'utf8').trim();
    }
    else if (argument === '--state') result.state = path.resolve(argv[++index]);
    else if (argument === '--workspace') {
      result.workspace = argv[++index];
      result.workspaceExplicit = true;
    }
    else if (argument === '--help') result.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.help) return result;
  result.pipeExplicit ||= argv.includes('--pipe');
  if (result.ipcSecret.length < 32 || result.ipcSecret.length > 256
    || /[\u0000-\u0020\u007f]/u.test(result.ipcSecret)) {
    throw new Error('A random IPC secret of 32 to 256 printable characters is required');
  }
  if (!result.pipeExplicit) {
    const suffix = crypto.createHash('sha256').update(result.ipcSecret, 'utf8').digest('hex').slice(0, 24);
    result.pipe = `eaw-localisation-hub-${suffix}`;
  }
  result.repo = path.resolve(result.repo);
  if (!result.workspace) {
    const branch = runGitSync(['branch', '--show-current'], {
      cwd: result.repo,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (branch.status !== 0 || !branch.stdout.trim()) {
      const detail = String(branch.stderr ?? '').trim();
      throw new Error(detail
        ? `Не удалось определить текущую Git-ветку: ${detail}`
        : 'Репозиторий находится в detached HEAD либо текущая Git-ветка недоступна.');
    }
    result.workspace = branch.stdout.trim();
  }
  const serverUrl = new URL(result.server);
  if (!['ws:', 'wss:'].includes(serverUrl.protocol)) {
    throw new Error('Server URL must use ws:// or wss://');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname);
  if (serverUrl.protocol === 'ws:' && !loopback) {
    throw new Error('Refusing a plaintext remote connection; use wss://');
  }
  return result;
}

function namedPipePath(name) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return path.join(os.tmpdir(), `${name}.sock`);
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node apps/agent/src/main.mjs --repo PATH [--server ws://127.0.0.1:3210]');
  console.log('       [--pipe NAME] [--user NAME] [--color #RRGGBB] [--workspace BRANCH] [--state PATH]');
  console.log('       [--token TOKEN | --token-file PATH] [--ipc-secret SECRET]');
  process.exit(0);
}

const hub = new AgentHub(options);
const reviewServer = await startReviewServer(hub, options);
options.reviewOpen = (absolutePath, openOptions) => reviewServer.open(absolutePath, openOptions);
const pipePath = namedPipePath(options.pipe);
const pipeServer = net.createServer((socket) => hub.attachSocket(socket));
pipeServer.on('error', () => {
  console.error('[agent] named pipe failed');
  process.exitCode = 1;
});
await new Promise((resolve, reject) => {
  pipeServer.once('error', reject);
  pipeServer.listen(pipePath, resolve);
});
const instanceRegistration = await registerAgentInstance(options, { version: DISPLAY_VERSION });

console.log(`[agent] EaW Localisation Hub ${DISPLAY_VERSION}`);
console.log('[agent] pipe: ready');
console.log('[agent] review application: ready');

async function shutdown(signal) {
  console.log(`[agent] ${signal}: shutting down`);
  await reviewServer.close();
  await new Promise((resolve) => pipeServer.close(resolve));
  await hub.close();
  await unregisterAgentInstance(instanceRegistration);
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
