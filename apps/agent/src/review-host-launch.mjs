import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function publishReviewHostEndpoint(directory, { port, token }) {
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${port}.session`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const origin = new URL(`http://127.0.0.1:${port}`).origin;
  // Native Review signs wide strings, whose Windows representation is UTF-16LE.
  const proof = createHmac('sha256', Buffer.from(token, 'utf16le'))
    .update(`endpoint\n${origin}\n`, 'utf16le')
    .digest('hex');
  try {
    await fs.writeFile(temporary, `${process.pid} ${proof}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return () => fs.rm(destination, { force: true });
}

export function createReviewHostLauncher({ start = spawn, timeout = 25_000 } = {}) {
  const pending = new Map();

  function report(id, opened) {
    const finish = pending.get(id);
    if (!finish) return false;
    finish(opened ? null : new Error('Английский файл не загрузился в Review.'));
    return true;
  }

  async function open(executable, origin, fragment) {
    if (pending.size >= 8) throw new Error('Дождитесь открытия окна английского оригинала.');
    const id = randomUUID();
    fragment.set('launch', id);
    const child = start(executable, [`${origin}/#${fragment}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        pending.delete(id);
        clearTimeout(timer);
        child.off('exit', exited);
        if (error) reject(error);
        else resolve(undefined);
      };
      // A delegating process exits successfully before the existing window loads the file.
      const exited = (code) => {
        if (code !== 0) finish(new Error('Не удалось запустить окно английского оригинала.'));
      };
      const timer = setTimeout(() => {
        finish(new Error('Review не подтвердил открытие английского файла.'));
      }, timeout);
      pending.set(id, finish);
      child.once('error', () => finish(new Error('Не удалось запустить окно английского оригинала.')));
      child.on('exit', exited);
    });
  }

  function close() {
    for (const finish of pending.values()) finish(new Error('Desktop Agent остановлен.'));
  }

  return { open, report, close };
}
