import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export interface AgentInstanceOptions {
  state: string;
  pipe: string;
  server: string;
  repo: string;
}

export interface AgentInstanceRecord {
  schema: 1;
  pid: number;
  startedAt: string;
  pipe: string;
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

export async function registerAgentInstance(options: AgentInstanceOptions,
  details: { version?: string } = {}): Promise<AgentInstanceRegistration> {
  const target = instanceRegistryPath(options.state);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const record: AgentInstanceRecord = {
    schema: 1,
    pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    pipe: options.pipe,
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
