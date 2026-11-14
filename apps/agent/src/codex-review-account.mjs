import { spawn } from 'node:child_process';
import { LOCALISATION_AI_MODEL } from '../../../packages/shared/src/ai-localisation.mts';

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_ERROR = 'Не удалось войти в Codex. Попробуйте ещё раз.';

export async function openCodexLoginInBrowser(value) {
  const url = new URL(value);
  if (!['https://auth.openai.com', 'https://chatgpt.com'].includes(url.origin) || url.username || url.password) {
    throw new Error(LOGIN_ERROR);
  }
  // Pass the validated HTTPS URL as data. Review's WebView blocks external navigation.
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

export class CodexReviewAccount {
  pending = null;
  busy = false;
  failed = false;

  constructor({ openBrowser = openCodexLoginInBrowser, changed }) {
    this.openBrowser = openBrowser;
    this.changed = changed;
  }

  async read(worker, signal) {
    const { account } = await worker.call('account/read', { refreshToken: false }, signal, 5000);
    const signedIn = account?.type === 'chatgpt';
    return { model: LOCALISATION_AI_MODEL, signedIn,
      email: signedIn && typeof account.email === 'string' ? account.email : '',
      loginPending: Boolean(this.pending), loginFailed: this.failed && !signedIn };
  }

  finish(attempt, failed = false) {
    if (this.pending !== attempt) return;
    clearTimeout(attempt.timer);
    attempt.worker.listeners.delete(attempt.receive);
    this.pending = null;
    this.failed = failed;
    this.changed();
  }

  async login(worker) {
    const state = await this.read(worker);
    if (state.signedIn || this.pending) return state;
    this.failed = false;
    const attempt = { worker, id: null, timer: null, completed: null, receive: message => {
      if (message.method === 'local/closed') this.finish(attempt, true);
      if (message.method !== 'account/login/completed') return;
      if (attempt.id === null) attempt.completed = message.params;
      else if (message.params?.loginId === attempt.id) this.finish(attempt, !message.params.success);
    } };
    this.pending = attempt;
    worker.listeners.add(attempt.receive);
    try {
      const result = await worker.call('account/login/start', { type: 'chatgpt' });
      if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string' || !result.authUrl) throw new Error(LOGIN_ERROR);
      attempt.id = result.loginId;
      if (attempt.completed?.loginId === attempt.id) this.finish(attempt, !attempt.completed.success);
      if (this.pending !== attempt) return this.read(worker);
      attempt.timer = setTimeout(() => {
        this.finish(attempt, true);
        worker.close();
      }, LOGIN_TIMEOUT_MS);
      attempt.timer.unref();
      await this.openBrowser(result.authUrl);
      return this.read(worker);
    } catch {
      this.finish(attempt, true);
      worker.close();
      throw new Error(LOGIN_ERROR);
    }
  }

  async cancel(worker) {
    const attempt = this.pending;
    if (attempt?.id) {
      await worker.call('account/login/cancel', { loginId: attempt.id });
      this.finish(attempt);
    }
    return this.read(worker);
  }

  async logout(worker) {
    await worker.call('account/logout', undefined);
    this.failed = false;
    this.changed();
    return { model: LOCALISATION_AI_MODEL, signedIn: false, email: '', loginPending: false, loginFailed: false };
  }
}
