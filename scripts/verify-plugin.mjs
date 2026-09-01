import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zig = path.join(projectRoot, '.tools', 'zig-extract', 'zig-windows-x86_64-0.13.0', 'zig.exe');
const testExecutable = path.join(projectRoot, 'dist', 'plugin-smoke.exe');
const protocolTestExecutable = path.join(projectRoot, 'dist', 'protocol-message-test.exe');
const plugin = path.join(projectRoot, 'dist', 'EawLocalisationHub', 'EawLocalisationHub.dll');

async function run(command, args) {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exit(exitCode);
}

await run(zig, [
  'c++',
  path.join(projectRoot, 'test', 'native', 'plugin-smoke.cpp'),
  '-target', 'x86_64-windows-gnu',
  '-std=c++20',
  '-O0',
  '-static',
  '-o', testExecutable,
]);
await run(testExecutable, [plugin]);
await run(zig, [
  'c++',
  path.join(projectRoot, 'test', 'native', 'protocol-message-test.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'EditorInterop.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'IpcSecurity.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'PluginLifecycle.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'ProtocolMessage.cpp'),
  path.join(projectRoot, 'plugin', 'src', 'VisualStyle.cpp'),
  '-target', 'x86_64-windows-gnu',
  '-std=c++20',
  '-O0',
  '-static',
  '-I', path.join(projectRoot, 'plugin', 'src'),
  '-I', path.join(projectRoot, 'vendor', 'npp-plugin-template', 'src'),
  '-I', path.join(projectRoot, 'vendor', 'nlohmann-json', 'single_include'),
  '-lcrypt32',
  '-ladvapi32',
  '-o', protocolTestExecutable,
]);
await run(protocolTestExecutable, []);
