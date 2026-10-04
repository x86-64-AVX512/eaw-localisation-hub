import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveUiLanguage } from '../../../packages/shared/src/ui-language.mts';

let windowsCulturePromise;
async function windowsUiCulture() {
  if (process.platform !== 'win32') return '';
  windowsCulturePromise ??= promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Globalization.CultureInfo]::CurrentUICulture.Name'], { windowsHide: true, timeout: 5000 })
    .then(({ stdout }) => stdout.trim(), () => '');
  return windowsCulturePromise;
}

export async function readUiLanguage(stateDirectory, cultureProvider = windowsUiCulture) {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(path.join(stateDirectory, 'ui-language.json'), 'utf8')); } catch {}
  const preference = ['auto', 'ru', 'en'].includes(saved?.preference) ? saved.preference : 'auto';
  const culture = await cultureProvider();
  return { preference, windowsUiCulture: culture, language: resolveUiLanguage(preference, culture) };
}

export async function saveUiLanguage(stateDirectory, preference, cultureProvider = windowsUiCulture) {
  if (!['auto', 'ru', 'en'].includes(preference)) throw new Error('Invalid UI language preference');
  await fs.mkdir(stateDirectory, { recursive: true });
  const target = path.join(stateDirectory, 'ui-language.json');
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const value = { preference, windowsUiCulture: await cultureProvider() };
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return readUiLanguage(stateDirectory, cultureProvider);
}

export async function handleUiLanguageApi({ request, response, requestUrl, stateDirectory }) {
  if (requestUrl.pathname !== '/api/ui-language') return false;
  let status = 200, payload;
  try {
    if (request.method === 'GET') payload = await readUiLanguage(stateDirectory);
    else if (request.method === 'POST') {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024) throw new Error('UI language request is too large');
        chunks.push(chunk);
      }
      payload = await saveUiLanguage(stateDirectory, JSON.parse(Buffer.concat(chunks).toString('utf8')).preference);
    } else { status = 405; payload = { error: 'Method not allowed' }; }
  } catch (error) { status = 400; payload = { error: error.message }; }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
  return true;
}
