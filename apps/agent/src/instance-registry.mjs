import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export function instanceRegistryPath(stateDirectory) {
  return path.join(stateDirectory, 'agent-instance.json');
}

export async function registerAgentInstance(options, details = {}) {
  const target = instanceRegistryPath(options.state);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const record = {
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
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
  }
  await fs.chmod(target, 0o600).catch(() => {});
  return { target, record };
}

export async function unregisterAgentInstance(registration) {
  if (!registration?.target) return;
  try {
    const current = JSON.parse(await fs.readFile(registration.target, 'utf8'));
    if (current.pid !== registration.record.pid || current.startedAt !== registration.record.startedAt) return;
    await fs.rm(registration.target, { force: true });
  } catch (error) {
    // A stale/corrupt registry must never prevent the Agent from shutting down.
    if (error.code === 'ENOENT') return;
  }
}
