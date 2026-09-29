import crypto from 'node:crypto';

export function mergeStateRevision(...texts: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const text of texts) hash.update(`${Buffer.byteLength(text, 'utf8')}:`).update(text);
  return hash.digest('hex');
}

export function mergeConflictId(revision: string, key: string): string {
  return mergeStateRevision(revision, key);
}
