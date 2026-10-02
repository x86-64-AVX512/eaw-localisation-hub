import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DISPLAY_VERSION } from '../../../packages/shared/src/constants.mts';
import { AgentHub } from './agent-hub.mjs';
import { runGitSync } from './git-executable.mts';
import { startReviewServer } from './review-server.mjs';
import { registerAgentInstance, unregisterAgentInstance } from './instance-registry.mts';
import { RepositorySync } from './repository-sync.mjs';

function parseArguments(argv) {
  const environmentToken = process.env.EAW_HUB_TOKEN?.trim() ?? '';
  delete process.env.EAW_HUB_TOKEN;
  const result = {
    server: 'ws://127.0.0.1:3210',
    repo: process.cwd(),
    user: process.env.EAW_HUB_USER ?? os.userInfo().username,
    color: process.env.EAW_HUB_COLOR ?? '#6aa9ff',
    token: environmentToken,
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

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log('Usage: node apps/agent/src/main.mjs --repo PATH [--server ws://127.0.0.1:3210]');
  console.log('       [--user NAME] [--color #RRGGBB] [--workspace BRANCH] [--state PATH]');
  console.log('       [--token TOKEN | --token-file PATH]');
  process.exit(0);
}

const hub = new AgentHub(options);
const reviewServer = await startReviewServer(hub, options);
options.reviewOpen = (absolutePath, openOptions) => reviewServer.open(absolutePath, openOptions);
const instanceRegistration = await registerAgentInstance(options, { version: DISPLAY_VERSION });
const repositorySync = new RepositorySync(hub).start();
hub.repositorySync = repositorySync;

console.log(`[agent] EaW Localisation Hub ${DISPLAY_VERSION}`);
console.log('[agent] review application: ready');

async function shutdown(signal) {
  console.log(`[agent] ${signal}: shutting down`);
  await repositorySync.close();
  await reviewServer.close();
  await hub.close();
  await unregisterAgentInstance(instanceRegistration);
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
