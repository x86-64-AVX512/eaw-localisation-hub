import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SAFE_REMOTE_ROOT = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_RELEASE_ID = /^[A-Za-z0-9._-]+$/;

export function validateDeploymentRequest(request) {
  const host = String(request?.host ?? '').trim();
  const username = String(request?.username ?? '').trim();
  const remoteRoot = String(request?.remoteRoot ?? '').trim().replace(/\/+$/, '');
  const port = Number(request?.port ?? 22);
  if (!host || /[\s/\\]/.test(host)) throw new Error('Укажите корректный адрес VPS.');
  if (!username || !/^[A-Za-z0-9._-]+$/.test(username)) throw new Error('Укажите корректного SSH-пользователя.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH-порт должен быть числом от 1 до 65535.');
  if (!SAFE_REMOTE_ROOT.test(remoteRoot) || remoteRoot === '/' || remoteRoot.includes('/../')) {
    throw new Error('Удалённый каталог должен быть безопасным абсолютным путём, но не корнем файловой системы.');
  }
  if (!request.password && !request.privateKeyPath) throw new Error('Укажите пароль или SSH-ключ.');
  return { ...request, host, username, remoteRoot, port };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function fingerprintSha256(rawKey) {
  return `SHA256:${createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`;
}

export function deploymentId(version, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const result = `${version}-${stamp}`;
  if (!SAFE_RELEASE_ID.test(result)) throw new Error('Не удалось сформировать безопасный идентификатор выпуска.');
  return result;
}

export function remoteInspectionCommand(remoteRoot) {
  const root = shellQuote(remoteRoot);
  return [
    'set -eu',
    'command -v docker >/dev/null 2>&1',
    'docker compose version >/dev/null 2>&1',
    `if [ -f ${root}/VERSION ]; then cat ${root}/VERSION; else printf '%s\\n' '<not-installed>'; fi`,
  ].join('\n');
}

export function remoteDeploymentCommand({ remoteRoot, uploadPath, releaseId, expectedDigest, preferOffline = false }) {
  if (!SAFE_RELEASE_ID.test(releaseId)) throw new Error('Unsafe release id.');
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Unsafe deployment digest.');
  const root = shellQuote(remoteRoot);
  const upload = shellQuote(uploadPath);
  const stage = shellQuote(`${remoteRoot}.stage-${releaseId}`);
  const rollbackRoot = `${remoteRoot}.rollbacks`;
  const rollback = shellQuote(`${rollbackRoot}/${releaseId}.tar.gz`);
  const rollbackDir = shellQuote(rollbackRoot);
  const healthUrl = 'http://127.0.0.1:${HUB_PORT:-3210}/health';
  return [
    'set -eu',
    `ROOT=${root}`,
    `STAGE=${stage}`,
    `UPLOAD=${upload}`,
    `ROLLBACK=${rollback}`,
    `ROLLBACK_DIR=${rollbackDir}`,
    'cleanup() { rm -rf -- "$STAGE"; rm -f -- "$UPLOAD"; }',
    'trap cleanup EXIT INT TERM',
    'command -v docker >/dev/null 2>&1 || { echo "Docker is not installed" >&2; exit 20; }',
    'docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is not installed" >&2; exit 21; }',
    `printf '%s  %s\\n' ${shellQuote(expectedDigest)} "$UPLOAD" | sha256sum -c -`,
    'rm -rf -- "$STAGE"',
    'mkdir -p -- "$STAGE" "$ROLLBACK_DIR"',
    'tar -xzf "$UPLOAD" -C "$STAGE"',
    'test -f "$STAGE/Dockerfile" && test -f "$STAGE/deploy/docker-compose.yml" && test -f "$STAGE/VERSION"',
    'if [ -d "$ROOT" ]; then',
    '  PREVIOUS_IMAGE=$(cd "$ROOT/deploy" && docker compose images -q server 2>/dev/null | head -n 1 || true)',
    '  tar -czf "$ROLLBACK" --exclude=deploy/backups --exclude=deploy/rollbacks -C "$ROOT" .',
    '  if [ -f "$ROOT/deploy/.env" ]; then cp "$ROOT/deploy/.env" "$STAGE/deploy/.env"; fi',
    'fi',
    'mkdir -p "$STAGE/deploy/backups"',
    'rollback() {',
    '  echo "Deployment failed; restoring previous release." >&2',
    '  if [ -f "$ROLLBACK" ]; then',
    '    ROLLBACK_STAGE="${STAGE}.rollback"',
    '    rm -rf -- "$ROLLBACK_STAGE" && mkdir -p -- "$ROLLBACK_STAGE"',
    '    tar -xzf "$ROLLBACK" -C "$ROLLBACK_STAGE"',
    '    rm -rf -- "$ROOT/apps" "$ROOT/packages"',
    '    rm -f -- "$ROOT/Dockerfile" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/VERSION"',
    '    cp -a "$ROLLBACK_STAGE/apps" "$ROLLBACK_STAGE/packages" "$ROOT/"',
    '    cp "$ROLLBACK_STAGE/Dockerfile" "$ROLLBACK_STAGE/package.json" "$ROLLBACK_STAGE/package-lock.json" "$ROLLBACK_STAGE/VERSION" "$ROOT/"',
    '    find "$ROOT/deploy" -mindepth 1 -maxdepth 1 ! -name .env ! -name backups ! -name rollbacks -exec rm -rf -- {} + 2>/dev/null || true',
    '    cp -a "$ROLLBACK_STAGE/deploy/." "$ROOT/deploy/"',
    '    (cd "$ROOT/deploy" && docker compose up -d --no-build server) || true',
    '  fi',
    '}',
    'trap rollback HUP',
    'mkdir -p -- "$ROOT"',
    'rm -rf -- "$ROOT/apps" "$ROOT/packages"',
    'rm -f -- "$ROOT/Dockerfile" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/VERSION"',
    'cp -a "$STAGE/apps" "$STAGE/packages" "$ROOT/"',
    'cp "$STAGE/Dockerfile" "$STAGE/package.json" "$STAGE/package-lock.json" "$STAGE/VERSION" "$ROOT/"',
    'mkdir -p "$ROOT/deploy/backups"',
    'find "$ROOT/deploy" -mindepth 1 -maxdepth 1 ! -name .env ! -name backups ! -name rollbacks -exec rm -rf -- {} + 2>/dev/null || true',
    'cp -a "$STAGE/deploy/." "$ROOT/deploy/"',
    'cd "$ROOT/deploy"',
    `ONLINE_BUILD_OK=${preferOffline ? '0' : 'pending'}`,
    'if [ "$ONLINE_BUILD_OK" = pending ] && timeout 300 docker compose build server; then ONLINE_BUILD_OK=1; fi',
    'if [ "$ONLINE_BUILD_OK" != 1 ]; then',
    '  echo "Online build failed; trying the existing server image as an offline base." >&2',
    '  test -n "${PREVIOUS_IMAGE:-}" || { kill -HUP $$; exit 30; }',
    '  TARGET_IMAGE=$(docker compose config --images | head -n 1)',
    '  docker build --build-arg "PREVIOUS_IMAGE=$PREVIOUS_IMAGE" -f Dockerfile.incremental -t "$TARGET_IMAGE" .. || { kill -HUP $$; exit 30; }',
    'fi',
    'docker compose up -d --no-build server || { kill -HUP $$; exit 30; }',
    'healthy=0',
    'attempt=0',
    'while [ "$attempt" -lt 30 ]; do',
    `  if command -v curl >/dev/null 2>&1 && curl -fsS ${healthUrl} >/tmp/eaw-hub-health.json 2>/dev/null; then healthy=1; break; fi`,
    '  if command -v wget >/dev/null 2>&1 && wget -qO /tmp/eaw-hub-health.json "' + healthUrl + '" 2>/dev/null; then healthy=1; break; fi',
    '  attempt=$((attempt + 1))',
    '  sleep 2',
    'done',
    'if [ "$healthy" -ne 1 ]; then docker compose logs --tail=80 server >&2 || true; kill -HUP $$; exit 31; fi',
    'cat /tmp/eaw-hub-health.json',
    'printf "\\nDEPLOYED_VERSION="; cat "$ROOT/VERSION"',
    'trap - HUP',
  ].join('\n');
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${file} завершился с кодом ${code}: ${stderr || stdout}`));
    });
  });
}

export async function createServerPayload(projectRoot, version) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'eaw-hub-deploy-'));
  const stageRoot = path.join(temporaryRoot, 'payload');
  const archivePath = path.join(temporaryRoot, `eaw-hub-server-${version}.tar.gz`);
  await mkdir(stageRoot, { recursive: true });
  const files = ['Dockerfile', 'package.json', 'package-lock.json', 'VERSION'];
  const directories = ['apps/server', 'packages/shared', 'deploy'];
  const serverScripts = ['scripts/manage-server.mjs'];
  for (const relative of files) {
    const source = path.join(projectRoot, relative);
    await access(source, fsConstants.R_OK);
    await cp(source, path.join(stageRoot, relative));
  }
  for (const relative of serverScripts) {
    const source = path.join(projectRoot, relative);
    await access(source, fsConstants.R_OK);
    const destination = path.join(stageRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  for (const relative of directories) {
    const destination = path.join(stageRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(projectRoot, relative), destination, {
      recursive: true,
      filter: (source) => !/(?:^|[\\/])(?:backups|rollbacks)(?:[\\/]|$)/i.test(source) && !/[\\/]\.env$/i.test(source),
    });
  }
  await writeFile(path.join(stageRoot, 'deployment.json'), JSON.stringify({ version, createdAt: new Date().toISOString() }), 'utf8');
  await runProcess('tar.exe', ['-czf', archivePath, '-C', stageRoot, '.']);
  const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  return {
    archivePath,
    digest,
    dispose: () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}
