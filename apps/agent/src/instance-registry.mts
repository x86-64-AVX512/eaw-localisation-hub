import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';

export interface AgentInstanceOptions {
  state: string;
  server: string;
  repo: string;
}

export interface AgentInstanceRecord {
  schema: 1;
  pid: number;
  startedAt: string;
  server: string;
  repository: string;
  version: string;
}

export interface AgentInstanceRegistration {
  target: string;
  record: AgentInstanceRecord;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

export function instanceRegistryPath(stateDirectory: string): string {
  return path.join(stateDirectory, 'agent-instance.json');
}

function instanceAlreadyRunning(cause: unknown) {
  return new Error('Desktop Agent is already running for this state directory', { cause });
}

async function acquireFileLock(stateDirectory: string): Promise<() => Promise<void>> {
  const { DatabaseSync } = await import('node:sqlite');
  let lock;
  try {
    lock = new DatabaseSync(path.join(stateDirectory, 'agent-instance.lock'));
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock?.close();
    // SQLITE_BUSY means another process holds the exclusive transaction.
    if (errorCode(error) === 'ERR_SQLITE_ERROR' && typeof error === 'object'
      && error !== null && 'errcode' in error && error.errcode === 5) {
      throw instanceAlreadyRunning(error);
    }
    throw error;
  }
  return async () => { lock.close(); };
}

export async function acquireAgentInstanceLock(stateDirectory: string): Promise<() => Promise<void>> {
  await fs.mkdir(stateDirectory, { recursive: true });
  const canonicalPath = await fs.realpath(stateDirectory);
  if (process.platform !== 'win32' && process.platform !== 'linux') return acquireFileLock(canonicalPath);
  const identity = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  const name = 'eaw-hub-agent-' + createHash('sha256').update(identity).digest('hex');
  // Windows pipes and Linux abstract sockets disappear when the owner process exits.
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : '\0' + name;
  const lock = createServer(socket => socket.destroy());
  try {
    lock.listen({ path: address, exclusive: true });
    await once(lock, 'listening');
  } catch (error) {
    if (errorCode(error) === 'EADDRINUSE') throw instanceAlreadyRunning(error);
    throw error;
  }
  return () => new Promise<void>((resolve, reject) => {
    lock.close(error => error ? reject(error) : resolve());
  });
}

export async function registerAgentInstance(options: AgentInstanceOptions,
  details: { version?: string } = {}): Promise<AgentInstanceRegistration> {
  const target = instanceRegistryPath(options.state);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const record: AgentInstanceRecord = {
    schema: 1,
    pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    server: options.server,
    repository: options.repo,
    version: details.version ?? '',
  };
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(temporary, 0o600).catch(() => {});
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'EPERM') throw error;
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  }
  await fs.chmod(target, 0o600).catch(() => {});
  return { target, record };
}

export async function unregisterAgentInstance(registration: AgentInstanceRegistration | null | undefined): Promise<void> {
  if (!registration?.target) return;
  try {
    const current: unknown = JSON.parse(await fs.readFile(registration.target, 'utf8'));
    if (!current || typeof current !== 'object' || !('pid' in current) || !('startedAt' in current)
      || current.pid !== registration.record.pid || current.startedAt !== registration.record.startedAt) return;
    await fs.rm(registration.target, { force: true });
  } catch (error) {
    // A stale/corrupt registry must never prevent the Agent from shutting down.
    if (errorCode(error) === 'ENOENT') return;
  }
}
