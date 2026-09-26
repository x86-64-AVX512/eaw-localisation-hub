import crypto from 'node:crypto';
import { runGitSync } from './git-executable.mts';
import fs from 'node:fs/promises';
import path from 'node:path';

interface RecoveryBinding {
  ticketId?: string;
  relativePath: string;
  gitRecoveryMarker?: string;
  hub: { options: { repo: string; state: string } };
  clients: Iterable<{ documents: ReadonlyMap<string, { binding: unknown }> }>;
}

interface RecoveryGitState {
  status?: string;
  remoteBlob?: string;
  remoteHead?: string;
}

function hasLocalChanges(repository: string, relativePath: string): boolean {
  const status = runGitSync(['status', '--porcelain', '--', relativePath], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
  });
  return status.status === 0 && Boolean(status.stdout.trim());
}

export async function preserveChangedFile(binding: RecoveryBinding,
  gitState: RecoveryGitState | null | undefined): Promise<string> {
  if (binding.ticketId || !gitState || (gitState.status !== 'file-outdated' && gitState.status !== 'conflict')) return '';
  const marker = `${gitState.remoteBlob ?? ''}:${gitState.remoteHead ?? ''}`;
  if (!marker.replace(':', '') || binding.gitRecoveryMarker === marker) return '';
  if (!hasLocalChanges(binding.hub.options.repo, binding.relativePath)) {
    binding.gitRecoveryMarker = marker;
    return '';
  }
  const attached = [...binding.clients].flatMap((client) => [...client.documents.entries()])
    .find(([, state]) => state.binding === binding);
  if (!attached) return '';
  const [absolutePath] = attached;
  const hash = crypto.createHash('sha256').update(binding.relativePath).digest('hex').slice(0, 16);
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const directory = path.resolve(binding.hub.options.state, 'git-recovery', hash);
  const target = path.resolve(directory, `${timestamp}-${path.basename(binding.relativePath)}`);
  if (path.dirname(target) !== directory) throw new Error('Invalid Git recovery path');
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(absolutePath, target);
  binding.gitRecoveryMarker = marker;
  return target;
}
