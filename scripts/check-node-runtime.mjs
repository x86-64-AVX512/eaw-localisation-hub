import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// First security releases blocking the compromised eMudhra intermediate keys.
// New major versions need an explicit policy update before we redistribute them.
export const minimumNodeVersions = Object.freeze({ 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' });

export function isSecureNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(version));
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const minimum = minimumNodeVersions[actual[0]]?.split('.').map(Number);
  if (!minimum) return false;
  return actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2]);
}

export function assertSecureNodeVersion(version) {
  if (!isSecureNodeVersion(version)) {
    throw new Error(`Unsafe or unsupported Node.js ${version}. Use Node.js 22 >= 22.23.4, 24 >= 24.22.1, or 26 >= 26.12.1 (eMudhra security update).`);
  }
}

if (!process.argv[1] || pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assertSecureNodeVersion(process.versions.node);
  console.log(`[node-runtime-security] ${process.versions.node}`);
}
