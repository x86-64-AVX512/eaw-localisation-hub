import fs from 'node:fs';
import path from 'node:path';

const notFound = 'Codex CLI не найден. Выберите установку Codex в инсталлере Hub или установите Codex CLI отдельно, затем перезапустите Desktop Agent.';

function isFile(file) {
  try { return fs.statSync(file).isFile(); }
  catch { return false; }
}

export function codexExecutable(environment = process.env, platform = process.platform, architecture = process.arch) {
  const override = environment.EAW_HUB_CODEX_EXECUTABLE?.trim();
  if (platform !== 'win32') return override || 'codex';
  if (override && !/\.(?:cmd|bat)$/iu.test(override)) return override;

  const npmArchitecture = { x64: 'x86_64', arm64: 'aarch64' }[architecture];
  const target = `${npmArchitecture}-pc-windows-msvc`;
  const windowsPath = Object.entries(environment).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  const directories = override ? [path.dirname(path.resolve(override))] : windowsPath.split(';');
  if (!override && environment.LOCALAPPDATA) {
    // Setup can start the Agent before the shell picks up WinGet's PATH changes.
    const wingetRoot = path.join(environment.LOCALAPPDATA, 'Microsoft', 'WinGet');
    directories.push(
      path.join(environment.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'),
      path.join(wingetRoot, 'Links'),
      path.join(wingetRoot, 'Packages', 'OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe'),
    );
  }
  for (const entry of directories) {
    const directory = entry.trim().replace(/^"|"$/gu, '');
    if (!directory || !path.isAbsolute(directory)) continue;
    const native = path.join(directory, 'codex.exe');
    if (!override && isFile(native)) return native;
    if (!npmArchitecture || !isFile(override ? path.resolve(override) : path.join(directory, 'codex.cmd'))) continue;
    const pkg = path.join(directory, 'node_modules', '@openai', 'codex');
    // npm's .cmd shim delegates to the platform package. Launch its native
    // executable so the Agent can terminate the actual app-server directly.
    for (const vendor of [
      path.join(pkg, 'node_modules', '@openai', `codex-win32-${architecture}`, 'vendor', target),
      path.join(directory, 'node_modules', '@openai', `codex-win32-${architecture}`, 'vendor', target),
      path.join(pkg, 'vendor', target),
    ]) {
      const executable = [path.join(vendor, 'bin', 'codex.exe'), path.join(vendor, 'codex', 'codex.exe')].find(isFile);
      if (executable) return executable;
    }
  }
  throw new Error(notFound);
}
