import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = ['LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'package-lock.json'];
const forbiddenPaths = [
  /^(?:dist|output|node_modules|data|\.tools|\.playwright-cli)(?:\/|$)/i,
  /^apps\/agent\/review-web(?:\/|$)/i,
  /^deploy\/(?:\.env|backups|rollbacks)(?:\/|$)/i,
  /(?:^|\/)(?:auth\.json|bootstrap-invite\.txt)$/i,
  /\.eawhub\.enc$/i,
];
const textExtensions = new Set(['.c', '.cc', '.cpp', '.css', '.h', '.hpp', '.html', '.iss', '.js', '.json', '.md', '.mjs', '.ps1', '.sh', '.txt', '.yml', '.yaml', '.cmd', '.example']);
const maximumPublicFileBytes = 5 * 1024 * 1024;

function candidateFiles() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr || result.stdout}`);
  return [...new Set(result.stdout.split(/\r?\n/).map((value) => value.trim().replaceAll('\\', '/')).filter(Boolean))].sort();
}

function isAllowedAddress(address) {
  const octets = address.split('.').map(Number);
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
    (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
    octets.every((part) => part === 255);
}

const failures = [];
const files = candidateFiles();
for (const required of requiredFiles) {
  if (!files.includes(required)) failures.push(`Required public file is missing: ${required}`);
}

for (const relative of files) {
  if (forbiddenPaths.some((pattern) => pattern.test(relative))) {
    failures.push(`Forbidden runtime or generated path would be published: ${relative}`);
    continue;
  }
  const absolute = path.join(projectRoot, relative);
  let metadata;
  try { metadata = await stat(absolute); } catch { continue; }
  if (!metadata.isFile()) continue;
  if (metadata.size > maximumPublicFileBytes) failures.push(`Public file exceeds 5 MiB: ${relative}`);
  const extension = path.extname(relative).toLowerCase();
  if (!textExtensions.has(extension) && !['Dockerfile', 'LICENSE', 'VERSION'].includes(path.basename(relative))) continue;
  const content = await readFile(absolute, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    failures.push(`Private key material detected: ${relative}`);
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(content)) {
    failures.push(`Known token format detected: ${relative}`);
  }
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i.test(content)) {
    failures.push(`Credential-bearing URL detected: ${relative}`);
  }
  for (const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (!isAllowedAddress(match[0])) failures.push(`Public infrastructure IP detected in ${relative}: ${match[0]}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`[publication-audit] ${files.length} candidate path(s), no forbidden artifacts or public infrastructure addresses`);
}
