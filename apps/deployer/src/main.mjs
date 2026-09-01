import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'ssh2';
import { DISPLAY_VERSION } from '../../../packages/shared/src/constants.mjs';
import {
  createServerPayload,
  deploymentId,
  fingerprintSha256,
  remoteDeploymentCommand,
  remoteInspectionCommand,
  validateDeploymentRequest,
} from './deployment-core.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function emit(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

async function readRequest() {
  const inputReader = createInterface({ input: process.stdin, terminal: false });
  const input = await inputReader.question('');
  inputReader.close();
  if (!input.trim()) throw new Error('Deployer did not receive a request.');
  return validateDeploymentRequest(JSON.parse(input));
}

async function connect(request, { allowUntrusted = false } = {}) {
  const privateKey = request.privateKeyPath ? await readFile(request.privateKeyPath) : undefined;
  return new Promise((resolve, reject) => {
    const client = new Client();
    let observedFingerprint = '';
    const options = {
      host: request.host,
      port: request.port,
      username: request.username,
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
      hostHash: 'sha256',
      hostVerifier: (_hashed, callback) => {
        const accepted = allowUntrusted || !request.hostFingerprint || observedFingerprint === request.hostFingerprint;
        callback(accepted);
      },
    };
    // ssh2's hashed verifier does not expose the raw key. Capture it before hashing.
    options.hostHash = undefined;
    options.hostVerifier = (rawKey, callback) => {
      observedFingerprint = fingerprintSha256(rawKey);
      callback(allowUntrusted || (!!request.hostFingerprint && observedFingerprint === request.hostFingerprint));
    };
    if (request.password) options.password = request.password;
    if (privateKey) {
      options.privateKey = privateKey;
      if (request.privateKeyPassphrase) options.passphrase = request.privateKeyPassphrase;
    }
    client.once('ready', () => resolve({ client, fingerprint: observedFingerprint }));
    client.once('error', reject);
    client.connect(options);
  });
}

function execute(client, command, onLine) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = '';
      let stderr = '';
      const append = (kind, chunk) => {
        const text = chunk.toString('utf8');
        if (kind === 'stdout') stdout += text;
        else stderr += text;
        for (const line of text.split(/\r?\n/).filter(Boolean)) onLine?.(kind, line);
      };
      stream.on('data', (chunk) => append('stdout', chunk));
      stream.stderr.on('data', (chunk) => append('stderr', chunk));
      stream.once('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`Удалённая команда завершилась с кодом ${code}: ${stderr || stdout}`));
      });
    });
  });
}

function upload(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error);
      sftp.fastPut(localPath, remotePath, {}, (uploadError) => uploadError ? reject(uploadError) : resolve());
    });
  });
}

async function inspect(request) {
  const connection = await connect(request, { allowUntrusted: request.acceptNewHostKey === true });
  try {
    const result = await execute(connection.client, remoteInspectionCommand(request.remoteRoot));
    emit('inspection', {
      fingerprint: connection.fingerprint,
      remoteVersion: result.stdout.trim().split(/\r?\n/).at(-1) || '<unknown>',
      localVersion: DISPLAY_VERSION,
    });
  } finally {
    connection.client.end();
  }
}

async function deploy(request) {
  if (!request.hostFingerprint) throw new Error('Сначала проверьте VPS и подтвердите его SSH-отпечаток.');
  emit('progress', { message: `Сборка серверного пакета ${DISPLAY_VERSION}…` });
  const payload = await createServerPayload(projectRoot, DISPLAY_VERSION);
  const releaseId = deploymentId(DISPLAY_VERSION);
  const uploadPath = `/tmp/eaw-hub-${releaseId}.tar.gz`;
  let connection;
  try {
    emit('progress', { message: `SHA-256 пакета: ${payload.digest}` });
    connection = await connect(request);
    emit('progress', { message: 'Загрузка пакета на VPS…' });
    await upload(connection.client, payload.archivePath, uploadPath);
    emit('progress', { message: 'Создание резервной копии и обновление контейнера…' });
    const result = await execute(
      connection.client,
      remoteDeploymentCommand({
        remoteRoot: request.remoteRoot,
        uploadPath,
        releaseId,
        expectedDigest: payload.digest,
        preferOffline: request.preferOffline === true,
      }),
      (kind, line) => emit('remote', { kind, line }),
    );
    emit('deployed', { version: DISPLAY_VERSION, fingerprint: connection.fingerprint, output: result.stdout.trim() });
  } finally {
    connection?.client.end();
    await payload.dispose();
  }
}

async function diagnose(request) {
  const connection = await connect(request);
  try {
    const command = [
      'set -eu',
      'printf "PROCESSES\\n"',
      "ps -eo pid,etime,stat,comm,args | grep -E 'docker|buildkit|apk|npm' | grep -v grep || true",
      'printf "CONTAINERS\\n"',
      "docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}'",
    ].join('\n');
    const result = await execute(connection.client, command);
    emit('diagnosis', { output: result.stdout.trim() });
  } finally {
    connection.client.end();
  }
}

async function terminateProcess(request) {
  const processId = Number(request.processId);
  const signal = request.signal === 'KILL' ? 'KILL' : 'TERM';
  if (!Number.isInteger(processId) || processId < 2) throw new Error('Некорректный PID для остановки.');
  const connection = await connect(request);
  try {
    await execute(connection.client, `kill -${signal} ${processId}`);
    emit('terminated', { processId, signal });
  } finally {
    connection.client.end();
  }
}

try {
  const action = process.argv[2];
  const request = await readRequest();
  if (action === 'inspect') await inspect(request);
  else if (action === 'deploy') await deploy(request);
  else if (action === 'diagnose') await diagnose(request);
  else if (action === 'terminate-process') await terminateProcess(request);
  else throw new Error('Использование: main.mjs inspect|deploy (JSON передаётся через stdin).');
} catch (error) {
  emit('error', { message: error?.message || String(error) });
  process.exitCode = 1;
}
