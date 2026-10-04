import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runGitAsync, runGitSync } from './git-executable.mts';
import { clearTrackedLineEndingPreferences, normaliseLineEndings, withoutUtf8Bom } from '../../../packages/shared/src/text.mts';

export const REPOSITORY_SYNC_DEFAULTS = Object.freeze({
  autoFetch: false, autoPull: false, intervalMinutes: 5,
  sound: true, flash: true, notification: true,
});

export function repositorySyncDirectory(state, repository) {
  const absolute = path.resolve(repository).replace(/[\\/]+$/u, '');
  const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  return path.join(state, 'repository-sync', crypto.createHash('sha256').update(identity).digest('hex'));
}

export function repositorySyncSettings(value) {
  const defaults = REPOSITORY_SYNC_DEFAULTS;
  return {
    autoFetch: value?.autoFetch === true, autoPull: value?.autoPull === true,
    intervalMinutes: [1, 5, 10, 15, 30].includes(value?.intervalMinutes) ? value.intervalMinutes : 5,
    sound: typeof value?.sound === 'boolean' ? value.sound : defaults.sound,
    flash: typeof value?.flash === 'boolean' ? value.flash : defaults.flash,
    notification: typeof value?.notification === 'boolean' ? value.notification : defaults.notification,
  };
}

function readJson(target) {
  try { return JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/u, '')); }
  catch { return null; }
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Disable interactive credential prompts. Authentication stays in the user's
// Git credential/SSH setup; the Hub never stores or asks for a Git password.
function gitOptions(repo) {
  return { cwd: repo, encoding: /** @type {const} */ ('utf8'), timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
      GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND || 'ssh'} -o BatchMode=yes` } };
}

function git(repo, args) {
  const result = runGitSync(args, gitOptions(repo));
  if (result.status !== 0) throw new Error('Git не смог проверить состояние репозитория.');
  return String(result.stdout ?? '').trim();
}

export function repositorySnapshot(repo) {
  const branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const format = '%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)';
  const [upstream = '', remote = '', remoteRef = ''] = git(repo,
    ['for-each-ref', `--format=${format}`, `refs/heads/${branch}`]).split('\0');
  return { branch, head, upstream, remote, remoteRef };
}

function sameCheckout(left, right) {
  return ['branch', 'head', 'upstream', 'remote', 'remoteRef'].every((field) => left[field] === right[field]);
}

export function repositoryOperationInProgress(repo) {
  return ['index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
    'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START'].some((name) => {
    const target = git(repo, ['rev-parse', '--git-path', name]);
    return fs.existsSync(path.resolve(repo, target));
  });
}

export function repositoryWorktreeReason(repo) {
  if (repositoryOperationInProgress(repo)) return 'git-operation';
  // Porcelain includes the index, conflicts, submodules and untracked files.
  if (git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])) return 'dirty';
  if (git(repo, ['ls-files', '-v']).split('\n').some((line) => /^[a-zS] /u.test(line))) return 'hidden-index';
  return '';
}

export function repositoryReviewReason(hub) {
  if (hub.closing || hub.workspaceTransitioning || hub.workspaceBlocked || hub.gitCommitCheckPending) return 'syncing';
  for (const binding of hub.documents.values()) {
    if (binding.personalConflicts?.length || binding.personalGitConflicts?.length
      || binding.personalSelectionStale || binding.gitState?.status === 'conflict') return 'conflicts';
    // A server's "file-outdated" is exactly why the clean local checkout needs
    // updating. Other read-only states and unsent local buffers remain blockers.
    const gitBlocked = !binding.gitWritable && !['file-outdated', 'branch-outdated'].includes(binding.gitState?.status);
    // An outdated file cannot initialise its Review view until checkout moves
    // to the server's Git base. Only this UI wait is circular; retain every
    // delivery, projection, disk-conflict and worktree guard around it.
    const waitingForCheckout = !binding.ticketId && !binding.gitWritable
      && binding.gitState?.status === 'file-outdated';
    if (binding.closing || binding.paused || !binding.synced || gitBlocked
      || (binding.localUpdatePending && !binding.pendingUpdateSent)
      || binding.deliveryFailed || binding.flushWaiter || binding.personalRequestId
      || binding.personalRefreshTimer || binding.personalRefreshPending
      || (!binding.ticketId && !binding.personalReady)) return 'syncing';
    if (binding.materialisationActive) return 'saving';
    for (const client of binding.clients) {
      for (const state of client.documents.values()) {
        if (state.binding !== binding) continue;
        if (state.pendingExternal) return state.pendingExternal.conflicts?.length ? 'conflicts' : 'syncing';
        if ((!state.initialised || !state.initialReconciled) && !waitingForCheckout) return 'syncing';
        // A confirmed personal projection can still be waiting for the 500 ms
        // autosave timer. Do not treat its clean-yet-unwritten file as safe.
        if (!binding.ticketId && binding.gitWritable && typeof binding.localFileText === 'function') {
          const projected = binding.localFileText();
          if (projected === null || projected !== state.diskBase) return 'saving';
        }
      }
    }
  }
  // An unopened recovery buffer cannot be confirmed with the server. Be
  // conservative even if it belongs to a different repository in this profile.
  const pendingDirectory = path.join(hub.options.state, 'pending-document-updates');
  if (fs.existsSync(pendingDirectory) && fs.readdirSync(pendingDirectory).some((name) => name.endsWith('.update'))) {
    return 'recovery';
  }
  return '';
}

const REASONS = {
  dirty: 'Есть локальные изменения (в том числе переводы, индекс или новые файлы). Сохраните их коммитом либо разберите вручную в GitHub Desktop.',
  diverged: 'Локальная и удалённая ветки разошлись. Требуется ручное решение в GitHub Desktop; автоматическое слияние отключено.',
  'git-operation': 'Git выполняет другую операцию (слияние, rebase, checkout или блокировка индекса). Завершите её в GitHub Desktop.',
  'hidden-index': 'В индексе есть assume-unchanged/skip-worktree (в том числе sparse checkout). Автоматическое обновление не может безопасно проверить эти файлы; обновите ветку вручную.',
  'checkout-blocked': 'Git отказался обновить рабочие файлы. Возможны блокировка файла, игнорируемый файл на месте нового файла ветки или внешние изменения. Проверьте репозиторий в GitHub Desktop.',
  conflicts: 'В Review есть нерешённые конфликты. Сначала разберите их.',
  syncing: 'Ожидается подтверждение изменений Review сервером или завершение переключения ветки.',
  saving: 'Review сохраняет локальный файл. Проверка будет повторена.',
  recovery: 'Есть неподтверждённые буферы восстановления. Откройте соответствующие документы в Review, дождитесь синхронизации и закройте их для подтверждения буферов.',
  changed: 'Ветка, upstream или HEAD изменились во время проверки. Проверка будет повторена.',
  disabled: 'Автоматическая работа с Git выключена. Можно проверить или обновить ветку вручную.',
  'no-upstream': 'У текущей ветки нет удалённого upstream. Настройте отслеживание ветки в GitHub Desktop.',
  error: 'Проверка Git не завершилась. Проверьте сеть, доступ к remote и авторизацию GitHub Desktop.',
};

/** One service per running Agent. All mutations use a pinned fetched commit. */
export class RepositorySync {
  constructor(hub, { runFetch = runGitAsync, runMerge = runGitSync, now = Date.now } = {}) {
    this.hub = hub;
    this.directory = repositorySyncDirectory(hub.options.state, hub.options.repo);
    this.runFetch = runFetch;
    this.runMerge = runMerge;
    this.now = now;
    this.lastFetch = 0;
    this.lastFetchFailed = false;
    this.lastCheckout = '';
    this.lastRequest = readJson(path.join(this.directory, 'request.json'))?.id ?? '';
    this.activeBlock = '';
    this.alertId = '';
    this.lastCheckedAt = '';
    this.inFlight = null;
    this.stopped = false;
    this.settings = repositorySyncSettings(readJson(path.join(this.directory, 'settings.json')));
    this.automationEnabled = this.settings.autoFetch || this.settings.autoPull;
    this.pendingManual = null;
    this.currentRequestId = '';
    /** @type {{ [key: string]: any, stage: string, reason?: string }} */
    this.status = { stage: 'idle' };
    this.publish('idle', { reason: 'disabled' });
  }

  start() {
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 3000);
    this.timer.unref?.();
    void this.tick().catch(() => {});
    return this;
  }

  tick() {
    if (this.stopped || this.hub.closing) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.check().catch(() => this.publish('error', { reason: 'error' }))
      .then(() => {
        if (this.status.stage !== 'blocked' || !['syncing', 'saving'].includes(this.status.reason)) this.pendingManual = null;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  reviewStatus() {
    let checkout = null;
    try { checkout = repositorySnapshot(this.hub.options.repo); } catch {}
    return { ...this.status, checkout, workspace: this.hub.options.workspace,
      busy: Boolean(this.inFlight || this.pendingManual) };
  }

  requestUpdate(expectedCheckout) {
    if (this.stopped || this.hub.closing) throw new Error('Agent останавливается.');
    if (this.inFlight || this.pendingManual) throw new Error('Проверка или обновление уже выполняется.');
    const checkout = repositorySnapshot(this.hub.options.repo);
    if (!expectedCheckout || !sameCheckout(checkout, expectedCheckout)
      || checkout.branch !== this.hub.options.workspace) {
      throw new Error('Ветка или HEAD изменились. Повторите обновление и подтвердите текущую ветку.');
    }
    const id = crypto.randomUUID();
    writeJson(path.join(this.directory, 'request.json'),
      { schema: 1, id, pid: process.pid, action: 'update', expectedCheckout: checkout });
    this.currentRequestId = id;
    this.publish('checking', checkout);
    // Reuse the same serialised service as the Agent button and automation.
    void this.tick().catch(() => {});
    return id;
  }

  publish(stage, detail = {}) {
    if (detail.branch && this.activeBlock && this.activeBlock !== detail.branch) {
      this.activeBlock = ''; this.alertId = '';
    }
    const actionable = stage === 'blocked' && detail.behind > 0
      && ['dirty', 'diverged', 'git-operation', 'hidden-index', 'checkout-blocked', 'conflicts', 'recovery'].includes(detail.reason);
    // Keep one alert throughout an unresolved episode, including network errors
    // and transient waits. Changes in behind count never produce repeated sound.
    if (actionable && !this.activeBlock) {
      this.activeBlock = detail.branch;
      this.alertId = crypto.randomUUID();
    }
    if (['current', 'updated', 'disabled', 'available', 'no-upstream'].includes(stage)) {
      this.activeBlock = ''; this.alertId = '';
    }
    const message = detail.message ?? REASONS[detail.reason] ?? ({
      checking: 'Проверяем текущую ветку…', fetching: 'Загружаем сведения о новых коммитах…',
      updating: 'Безопасно обновляем текущую ветку (fast-forward)…',
      current: 'Ветка актуальна.', updated: 'Ветка обновлена. Review подключается к новому Git HEAD.',
      available: 'Есть новые коммиты. Автообновление ветки выключено.',
    })[stage] ?? 'Git: ожидание.';
    this.status = { schema: 1, pid: process.pid, repository: path.resolve(this.hub.options.repo),
      updatedAt: new Date(this.now()).toISOString(), checkedAt: this.lastCheckedAt,
      stage, message, alertId: actionable ? this.alertId : '', settings: this.settings,
      requestId: this.currentRequestId, ...detail,
      // Report the actual fetch deadline, not the UI/status polling time.
      nextCheckAt: (this.settings.autoFetch || this.settings.autoPull) && this.lastFetch > 0
        && !['disabled', 'no-upstream'].includes(stage) && detail.reason !== 'changed'
        ? new Date(this.lastFetch + this.settings.intervalMinutes * 60_000).toISOString() : null };
    writeJson(path.join(this.directory, 'status.json'), this.status);
  }

  async check() {
    const { hub } = this;
    const repo = hub.options.repo;
    this.settings = repositorySyncSettings(readJson(path.join(this.directory, 'settings.json')));
    const request = readJson(path.join(this.directory, 'request.json'));
    const freshManual = request?.id && request.id !== this.lastRequest && request.pid === process.pid
      && ['check', 'update'].includes(request.action) ? request.action : '';
    if (request?.id) this.lastRequest = request.id;
    if (freshManual) this.currentRequestId = request.id;
    if (freshManual === 'update') this.pendingManual = {
      until: this.now() + 30_000, branch: '', checkout: request.expectedCheckout ?? null,
    };
    else if (freshManual) this.pendingManual = null;
    const manual = freshManual || (this.pendingManual?.until > this.now() ? 'update' : '');
    const automation = this.settings.autoFetch || this.settings.autoPull;
    const wasAutomated = this.automationEnabled;
    this.automationEnabled = automation;
    if (!automation && !manual) {
      // Keep the last manual result visible. Turning automation off cancels its
      // alert; it does not erase a manual failure one timer tick after a click.
      if (wasAutomated || ['idle', 'disabled', 'checking', 'fetching', 'updating'].includes(this.status.stage)) {
        this.publish('disabled', { reason: 'disabled' });
      } else this.publish(this.status.stage, { ...this.status, updatedAt: new Date(this.now()).toISOString(), settings: this.settings });
      return;
    }
    // Local timer ticks must not advertise a remote check. Publish fetching only
    // when a real fetch is due; explicit Review requests publish checking above.
    let checkout;
    try { checkout = repositorySnapshot(repo); }
    catch { this.publish('blocked', { reason: 'changed' }); return; }
    if (this.pendingManual?.checkout && !sameCheckout(checkout, this.pendingManual.checkout)) {
      this.publish('blocked', { ...checkout, reason: 'changed' }); return;
    }
    if (this.pendingManual) {
      if (this.pendingManual.branch && checkout.branch !== this.pendingManual.branch) {
        this.pendingManual = null;
        this.publish('blocked', { ...checkout, reason: 'changed' }); return;
      }
      this.pendingManual.branch = checkout.branch;
    }
    if (checkout.branch !== hub.options.workspace || hub.workspaceTransitioning) {
      this.publish('blocked', { ...checkout, reason: 'changed' }); return;
    }
    if (!checkout.remote || checkout.remote === '.' || !checkout.remoteRef.startsWith('refs/heads/')
      || !checkout.upstream.startsWith('refs/remotes/')) {
      this.publish('no-upstream', { ...checkout, reason: 'no-upstream' }); return;
    }
    const stamp = JSON.stringify(checkout);
    if (freshManual || stamp !== this.lastCheckout || this.now() - this.lastFetch >= this.settings.intervalMinutes * 60_000) {
      this.publish('fetching', checkout);
      // An explicit destination ref prevents a configured fetch refspec from
      // updating a local branch. No prune, tags, recursion or arbitrary merge.
      const result = await this.runFetch(['-c', 'fetch.recurseSubmodules=false', 'fetch', '--no-tags',
        '--no-recurse-submodules', '--', checkout.remote, `+${checkout.remoteRef}:${checkout.upstream}`], gitOptions(repo));
      if (this.stopped || hub.closing) return;
      this.lastFetch = this.now(); this.lastCheckout = stamp;
      this.lastCheckedAt = new Date(this.lastFetch).toISOString();
      if (result.status !== 0) {
        this.lastFetchFailed = true;
        this.publish('error', { ...checkout, reason: 'error' }); return;
      }
      this.lastFetchFailed = false;
    }
    if (this.lastFetchFailed) { this.publish('error', { ...checkout, reason: 'error' }); return; }
    if (this.stopped || hub.closing) return;
    if (!sameCheckout(checkout, repositorySnapshot(repo))) {
      this.publish('blocked', { ...checkout, reason: 'changed' }); return;
    }
    const target = git(repo, ['rev-parse', '--verify', `${checkout.upstream}^{commit}`]);
    const counts = git(repo, ['rev-list', '--left-right', '--count', `${checkout.head}...${target}`]).split(/\s+/u).map(Number);
    const detail = { ...checkout, ahead: counts[0], behind: counts[1] };
    if (!detail.behind) { this.publish('current', detail); return; }
    if (manual === 'check' || (!this.settings.autoPull && manual !== 'update')) { this.publish('available', detail); return; }
    if (detail.ahead) { this.publish('blocked', { ...detail, reason: 'diverged' }); return; }
    const reason = repositoryWorktreeReason(repo) || repositoryReviewReason(hub);
    if (reason) { this.publish('blocked', { ...detail, reason }); return; }
    await this.fastForward(checkout, target, detail, manual === 'update');
  }

  async fastForward(checkout, target, detail, manual) {
    const { hub } = this;
    const repo = hub.options.repo;
    hub.repositoryUpdating = true;
    const epoch = hub.repositoryEditEpoch ?? 0;
    const bindings = [...hub.documents.values()];
    let updated = false;
    try {
      this.publish('updating', detail);
      await Promise.all(bindings.flatMap((binding) => [binding.materialisationWrite,
        ...[...binding.clients].flatMap((client) => [...client.documents.values()]
          .filter((state) => state.binding === binding).map((state) => state.diskCheckPromise))]));
      const acknowledgements = await Promise.all(bindings.map((binding) => binding.flushToServer()));
      if (acknowledgements.some((confirmed) => !confirmed)) {
        this.publish('blocked', { ...detail, reason: 'syncing' }); return;
      }
      // Settings and Git identity are rechecked after all asynchronous waits.
      const settings = repositorySyncSettings(readJson(path.join(this.directory, 'settings.json')));
      if (this.stopped || hub.closing || (!manual && !settings.autoPull)) return;
      const reason = (hub.repositoryEditEpoch ?? 0) !== epoch ? 'syncing'
        : repositoryWorktreeReason(repo) || repositoryReviewReason(hub);
      if (reason) { this.publish('blocked', { ...detail, reason }); return; }
      if (!sameCheckout(checkout, repositorySnapshot(repo))) {
        this.publish('blocked', { ...detail, reason: 'changed' }); return;
      }
      // Synchronous checkout deliberately excludes JS callbacks between the
      // final guards and Git's own worktree/index lock. Timeout is bounded.
      const result = this.runMerge(['-c', `core.hooksPath=${path.join(this.directory, 'disabled-hooks')}`, '-c', 'submodule.recurse=false',
        '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', target], gitOptions(repo));
      const after = repositorySnapshot(repo);
      updated = after.head !== checkout.head;
      if (updated) {
        hub.gitCommit = after.head;
        clearTrackedLineEndingPreferences();
        for (const binding of bindings) {
          if (binding.ticketId) continue;
          // Hold both watcher and writer guards until the new checkout has
          // become the disk base. It is not an external collaborative edit.
          binding.gitWritable = false;
          binding.synced = false;
          for (const client of binding.clients) {
            for (const [absolutePath, state] of client.documents) {
              if (state.binding !== binding) continue;
              try {
                // A pinned Git blob, not a potentially newer external disk
                // edit, defines the checkout base. Retain its trailing newline.
                const shown = runGitSync(['show', `${after.head}:${binding.relativePath}`],
                  { ...gitOptions(repo), maxBuffer: 16 * 1024 * 1024 });
                if (shown.status !== 0) throw Object.assign(new Error('File deleted in Git'), { code: 'ENOENT' });
                const text = normaliseLineEndings(withoutUtf8Bom(String(shown.stdout)));
                state.diskBase = text; state.diskSignature = '';
                state.materialisationExpected = null; state.materialisationDeadline = 0;
                binding.persistBaseSnapshot(state, text);
              } catch (error) { if (error.code !== 'ENOENT') throw error; state.diskBase = ''; }
              // A clean, guarded checkout supplies the initial disk base. Do
              // not later reconcile the pre-pull mirror as a user's edit.
              // Leave initialised untouched: the UI still needs server sync.
              state.initialReconciled = true;
            }
          }
        }
      }
      const succeeded = result.status === 0 && after.head === target && after.branch === checkout.branch;
      this.publish(succeeded ? 'updated' : 'blocked',
        { ...detail, ...after, behind: after.head === target ? 0 : detail.behind,
          ...(!succeeded ? { reason: result.status !== 0 ? 'checkout-blocked' : 'changed' } : {}) });
    } finally {
      if (updated) {
        for (const binding of bindings) {
          if (!binding.ticketId && !binding.closing) binding.reconnectForGitHead();
        }
      }
      hub.repositoryUpdating = false;
      for (const client of hub.clients) {
        for (const [absolutePath, state] of client.documents) {
          client.scheduleMaterialisation?.(absolutePath);
          if (updated) client.send({ type: 'notice', path: absolutePath,
            message: 'Git-ветка обновлена без слияния. Ожидается подтверждение нового HEAD сервером.' });
        }
      }
    }
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.inFlight;
  }
}
