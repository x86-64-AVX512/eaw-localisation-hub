import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '../packages/shared/src/constants.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const zig = path.join(
  projectRoot,
  '.tools',
  'zig-extract',
  'zig-windows-x86_64-0.13.0',
  'zig.exe',
);
const outputDirectory = path.join(projectRoot, 'dist', 'EawLocalisationHub');
const output = path.join(outputDirectory, 'EawLocalisationHub.dll');
const resourceOutput = path.join(outputDirectory, 'EawLocalisationHub.res');

try {
  await fs.access(zig);
} catch {
  throw new Error('Zig toolchain is missing. Run: powershell -ExecutionPolicy Bypass -File scripts/bootstrap-zig.ps1');
}

await fs.mkdir(outputDirectory, { recursive: true });
const resourceArguments = [
  'rc',
  '/nologo',
  `/fo${resourceOutput}`,
  path.join(projectRoot, 'plugin', 'resource', 'EawLocalisationHub.rc'),
];
const argumentsList = [
  'c++',
  path.join(projectRoot, 'plugin', 'src', 'CollaborationOverlays.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'EawLocalisationHub.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'EditorInterop.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'IpcSecurity.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'LegacyIntegrationSettings.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'PluginLifecycle.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'ProtocolMessage.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'VisualStyle.cpp'),
  '-target', 'x86_64-windows-gnu',
  '-std=c++20',
  '-O0',
  '-shared',
  '-DUNICODE',
  '-D_UNICODE',
  `-DEAW_HUB_PROTOCOL_VERSION=${PROTOCOL_VERSION}`,
  '-I', path.join(projectRoot, 'vendor', 'npp-plugin-template', 'src'),
  '-I', path.join(projectRoot, 'vendor', 'nlohmann-json', 'single_include'),
  '-lcomctl32',
  '-lcrypt32',
  '-ladvapi32',
  '-lgdi32',
  '-static',
  '-Wl,--subsystem,windows',
  resourceOutput,
  '-o', output,
];

async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(zig, args, { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const resourceExitCode = await run(resourceArguments);
if (resourceExitCode !== 0) process.exit(resourceExitCode);
const exitCode = await run(argumentsList);
if (exitCode !== 0) process.exit(exitCode);

await fs.writeFile(
  path.join(outputDirectory, 'README.txt'),
  [
    'EaW Localisation Hub 0.8.7F1',
    '',
    'Prototype build. Copy this entire EawLocalisationHub directory into the Notepad++ plugins directory.',
    'The Desktop Agent must be running before Notepad++ connects.',
    '',
  ].join('\r\n'),
  'utf8',
);
console.log(`[build] ${output}`);
