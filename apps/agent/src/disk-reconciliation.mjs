import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  computeSingleReplace,
  normaliseTrackedPath,
  normaliseLineEndings,
  readTrackedTextFile,
  withoutUtf8Bom,
  utf8ByteOffsetToUtf16Index,
} from '../../../packages/shared/src/text.mts';

const MAXIMUM_CONFLICT_TEXT = 60 * 1024;
function conflictText(value) {
  const text = String(value ?? '');
  return text.length <= MAXIMUM_CONFLICT_TEXT
    ? text : `${text.slice(0, MAXIMUM_CONFLICT_TEXT)}\n… diff truncated …`;
}

const DISK_ORIGIN = Symbol('external-disk-update');

function broadcastConflictReset(binding, absolutePath, source = 'disk') {
  for (const attached of binding.clients) {
    const state = attached.documents.get(absolutePath);
    if (state?.binding === binding) attached.send({
      type: 'externalConflictReset', path: absolutePath, source,
    });
  }
}

function currentHash(binding) {
  return crypto.createHash('sha256').update(binding.text.toString()).digest('hex');
}

function schedulePendingRetry(binding, client, absolutePath, state, pending, notice, delay) {
  if (pending.retryTimer) return;
  pending.retryTimer = setTimeout(() => {
    pending.retryTimer = null;
    if (state.pendingExternal === pending && binding.synced) {
      void confirmDiskMerge(binding, client, absolutePath, state, pending, notice);
    }
  }, delay);
  pending.retryTimer.unref?.();
}

async function confirmDiskMerge(binding, client, absolutePath, state, pending, notice) {
  if (pending.checking) return;
  pending.checking = true;
  try {
    const personalBefore = binding.localFileText();
    if (personalBefore === null) throw new Error('Personal projection is unavailable');
    const result = await binding.requestDiskMergeCheck(pending.base, pending.external,
      personalBefore, pending.resolutions, pending.initialUnknown === true);
    if (state.pendingExternal !== pending || state.binding !== binding
      || client.documents.get(absolutePath) !== state) return;
    if (result.error) throw new Error(result.error);
    if (result.stale || result.sharedHash !== currentHash(binding)
      || binding.localFileText() !== personalBefore) {
      pending.conflicts = null;
      binding.emitExternalConflicts(client, absolutePath, state);
      client.send({ type: 'notice', path: absolutePath,
        message: 'Совместный документ изменился во время проверки конфликта; проверка повторяется.' });
      schedulePendingRetry(binding, client, absolutePath, state, pending, notice, 250);
      return;
    }
    pending.conflicts = result.conflicts;
    if (result.conflicts.length) {
      binding.emitExternalConflicts(client, absolutePath, state);
      client.send({ type: 'notice', path: absolutePath,
        message: `Сервер подтвердил конфликтов: ${result.conflicts.length}.` });
      return;
    }
    binding.finishExternalMerge(client, absolutePath, state, result.sharedText, result.personalText, notice);
  } catch (error) {
    if (state.pendingExternal === pending) {
      pending.conflicts = null;
      if (!pending.errorNotified) client.send({ type: 'notice', path: absolutePath,
        message: 'Сервер не подтвердил состояние файла. Сохранение приостановлено до повторной проверки.' });
      pending.errorNotified = true;
      schedulePendingRetry(binding, client, absolutePath, state, pending, notice, 5000);
    }
  } finally {
    pending.checking = false;
  }
}

export function retryPendingDiskMerges(binding) {
  for (const client of binding.clients) {
    for (const [absolutePath, state] of client.documents) {
      const pending = state.pendingExternal;
      if (state.binding === binding && pending && !pending.checking) {
        if (pending.retryTimer) clearTimeout(pending.retryTimer);
        pending.retryTimer = null;
        void confirmDiskMerge(binding, client, absolutePath, state, pending,
          'Файл согласован с совместным документом после повторной проверки.');
      }
    }
  }
}

export function queueExternalMerge(binding, client, absolutePath, state, base, external, notice) {
  const pending = { base, external, resolutions: new Map(), conflicts: null, checking: false };
  state.pendingExternal = pending;
  void confirmDiskMerge(binding, client, absolutePath, state, pending, notice);
}

export function startFileWatcher(binding, client, absolutePath, state) {
  if (binding.ticketId) return;
  normaliseTrackedPath(binding.hub.options.repo, absolutePath);
  try {
    const directory = path.dirname(absolutePath);
    const targetName = path.basename(absolutePath).toLowerCase();
    state.diskWatcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
      if (filename && String(filename).toLowerCase() !== targetName) return;
      binding.scheduleDiskCheck(client, absolutePath, state);
    });
    state.diskWatcher.on('error', (error) => {
      console.error('[agent] file watcher failed');
    });
  } catch (error) {
    console.error('[agent] could not watch a document');
  }
  state.diskPollTimer = setInterval(() => {
    binding.scheduleDiskCheck(client, absolutePath, state, 0);
  }, 1000);
  state.diskPollTimer.unref?.();
}

export function scheduleDiskCheck(binding, client, absolutePath, state, delay = 200) {
  if (binding.ticketId) return;
  if (state.diskDebounce) clearTimeout(state.diskDebounce);
  state.diskDebounce = setTimeout(() => {
    state.diskDebounce = null;
    state.diskCheckPromise = state.diskCheckPromise
      .then(() => binding.checkDiskChange(client, absolutePath, state))
      .catch(() => console.error('[agent] disk merge failed'));
  }, delay);
}

export async function readDiskText(binding, absolutePath) {
  try {
    return normaliseLineEndings(withoutUtf8Bom(
      await readTrackedTextFile(binding.hub.options.repo, absolutePath),
    ));
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export async function checkDiskChange(binding, client, absolutePath, state) {
  if (binding.ticketId || binding.closing) return;
  if (binding.paused || state.binding !== binding || !client.documents.has(absolutePath)) return;
  if (binding.hub.gitOperationInProgress?.()) {
    binding.scheduleDiskCheck(client, absolutePath, state, 300);
    return;
  }
  let diskSignature = 'missing';
  try {
    const stats = await fs.promises.stat(absolutePath);
    diskSignature = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (state.diskSignature === diskSignature && state.materialisationExpected === null) return;
  const externalText = await binding.readDiskText(absolutePath);
  state.diskSignature = diskSignature;
  if (binding.paused || binding.closing || state.binding !== binding
      || client.documents.get(absolutePath) !== state) return;
  if (binding.hub.gitOperationInProgress?.()) {
    binding.scheduleDiskCheck(client, absolutePath, state, 300);
    return;
  }
  const personal = binding.localFileText();
  if (!binding.synced || !binding.gitWritable) return;

  if (state.materialisationExpected !== null) {
    if (externalText === state.materialisationExpected) {
      state.diskBase = externalText;
      state.materialisationExpected = null;
      state.materialisationDeadline = 0;
      state.materialisationMismatch = null;
      binding.persistBaseSnapshot(state, externalText);
      return;
    }
    if (Date.now() < state.materialisationDeadline
      && state.materialisationMismatch !== externalText) {
      state.materialisationMismatch = externalText;
      binding.scheduleDiskCheck(client, absolutePath, state, 300);
      return;
    }
    state.materialisationExpected = null;
    state.materialisationDeadline = 0;
    state.materialisationMismatch = null;
  }

  if (externalText === personal) {
    state.diskBase = personal;
    binding.persistBaseSnapshot(state, personal);
    if (state.pendingExternal) {
      state.pendingExternal = null;
      broadcastConflictReset(binding, absolutePath);
    }
    return;
  }
  if (externalText === state.diskBase) return;

  let gitText = null;
  try {
    gitText = binding.hub.readGitHeadText(binding.relativePath);
  } catch {}
  const personalBeforeConflict = personal ?? binding.personalText;
  if (gitText !== null && externalText === gitText && personalBeforeConflict !== gitText) {
    for (const attached of binding.clients) {
      const attachedState = attached.documents.get(absolutePath);
      if (!attachedState || attachedState.binding !== binding) continue;
      attachedState.pendingExternal = null;
      attachedState.diskBase = gitText;
      attachedState.materialisationExpected = null;
      attachedState.materialisationDeadline = 0;
      attachedState.materialisationMismatch = null;
      binding.persistBaseSnapshot(attachedState, gitText);
      attached.send({ type: 'externalConflictReset', path: absolutePath, source: 'disk' });
    }
    binding.replacePersonalDocument(gitText);
    client.send({
      type: 'notice', path: absolutePath,
      message: 'Git-откат применён только к вашему локальному файлу; совместный документ не изменён.',
    });
    return;
  }
  if (personal === null) return;

  const pending = { base: state.diskBase, external: externalText,
    resolutions: new Map(), conflicts: null, checking: false };
  state.pendingExternal = pending;
  await confirmDiskMerge(binding, client, absolutePath, state, pending,
    'Изменения с диска объединены с совместным документом.');
}

export function persistBaseSnapshot(binding, state, text) {
  if (state.basePersistText === text) return state.basePersistPromise;
  state.hasPersistedBase = true;
  state.basePersistText = text;
  state.basePersistPromise = state.basePersistPromise
    .catch(() => {})
    .then(() => binding.hub.saveBaseSnapshot(binding.relativePath, text))
    .catch(() => {
      if (state.basePersistText === text) {
        state.basePersistText = null;
        state.diskSignature = '';
      }
      console.error('[agent] could not persist a merge base');
    });
  const pendingWrite = state.basePersistPromise;
  binding.baseWrites.add(pendingWrite);
  pendingWrite.then(() => binding.baseWrites.delete(pendingWrite));
}

export function confirmDiskMaterialisation(binding, absolutePath, sourceState, text) {
  const deadline = Date.now() + 5000;
  const states = new Set([sourceState]);
  for (const client of binding.clients ?? []) {
    const state = client.documents.get(absolutePath);
    if (state?.binding === binding) states.add(state);
  }
  for (const state of states) {
    state.diskBase = text;
    state.materialisationExpected = text;
    state.materialisationDeadline = deadline;
    state.materialisationMismatch = null;
  }
  binding.persistBaseSnapshot?.(sourceState, text);
}

export function reconcileInitialDisk(binding, client, absolutePath, state) {
  if (binding.ticketId) {
    state.initialReconciled = true;
    return;
  }
  if (state.initialReconciled) return;
  const canonical = binding.text.toString();
  const personal = binding.localFileText();
  if (personal === null) return;
  state.initialReconciled = true;
  const localText = state.mirror;

  if (!state.hasPersistedBase) {
    if (localText === personal) {
      state.diskBase = personal;
      binding.persistBaseSnapshot(state, personal);
      return;
    }
    state.pendingExternal = {
      base: canonical,
      external: localText,
      resolutions: new Map(),
      initialUnknown: true,
    };
    void confirmDiskMerge(binding, client, absolutePath, state, state.pendingExternal,
      'Начальная база слияния создана; выбранная версия будет сохранена.');
    client.send({
      type: 'notice',
      message: 'Нет сохранённой базы слияния: ожидается проверка начального состояния сервером.',
    });
    return;
  }

  if (localText === personal) {
    state.diskBase = personal;
    binding.applyMergedText(canonical);
    binding.persistBaseSnapshot(state, personal);
    return;
  }

  const pending = { base: state.diskBase, external: localText,
    resolutions: new Map(), conflicts: null, checking: false };
  state.pendingExternal = pending;
  void confirmDiskMerge(binding, client, absolutePath, state, pending,
    'Локальный Git-файл согласован с совместной сессией после запуска.');
}

export function emitExternalConflicts(binding, client, absolutePath, state) {
  client.send({ type: 'externalConflictReset', path: absolutePath, source: 'disk' });
  const conflicts = state.pendingExternal?.conflicts ?? [];
  for (const conflict of conflicts) {
    let detail = 'Один и тот же ключ изменён совместно и на диске.';
    if (conflict.key === '__initial_state__') detail = 'База слияния ещё не создана. Выберите совместную версию или локальный файл Git.';
    else if (conflict.key === '__file_structure__') detail = 'Комментарии или структура файла изменены с обеих сторон.';
    else if (conflict.key === '__duplicate_keys__') detail = `${conflict.label}. Выбор применяется ко всему файлу.`;
    else if (conflict.externalLine == null) detail = 'Git удаляет ключ, изменённый в совместной сессии.';
    else if (conflict.collaborativeLine == null) detail = 'Git и совместная сессия по-разному добавили ключ.';
    client.send({
      type: 'externalConflict',
      path: absolutePath,
      source: 'disk',
      key: conflict.key,
      label: conflict.label,
      detail,
      baseLine: conflictText(conflict.baseLine),
      collaborativeLine: conflictText(conflict.collaborativeLine),
      externalLine: conflictText(conflict.externalLine),
    });
  }
}

export function applyMergedText(binding, nextText) {
  const canonical = binding.text.toString();
  const replacement = computeSingleReplace(canonical, nextText);
  if (!replacement) return;
  const start = utf8ByteOffsetToUtf16Index(canonical, replacement.positionByte);
  const end = utf8ByteOffsetToUtf16Index(
    canonical,
    replacement.positionByte + replacement.deleteBytes,
  );
  binding.document.transact(() => {
    if (end > start) binding.text.delete(start, end - start);
    if (replacement.insertText) binding.text.insert(start, replacement.insertText);
  }, DISK_ORIGIN);
}

export function finishExternalMerge(
  binding, client, absolutePath, state, sharedText, personalText, notice,
) {
  for (const attached of binding.clients) {
    const attachedState = attached.documents.get(absolutePath);
    if (!attachedState || attachedState.binding !== binding) continue;
    attachedState.pendingExternal = null;
    attachedState.diskBase = personalText;
    attachedState.materialisationExpected = personalText;
    attachedState.materialisationDeadline = Date.now() + 5000;
    attachedState.materialisationMismatch = null;
    attached.send({ type: 'externalConflictReset', path: absolutePath, source: 'disk' });
  }
  binding.personalText = personalText;
  binding.personalReady = true;
  binding.applyMergedText(sharedText);
  binding.replacePersonalDocument?.(personalText);
  client.send({ type: 'saveRequested', path: absolutePath });
  client.send({ type: 'notice', message: notice });
}

export function resolveExternalConflict(binding, client, absolutePath, message) {
  const state = binding.requireState(client, absolutePath);
  if (message.source && message.source !== 'disk') return false;
  if (!state.pendingExternal) {
    client.send({ type: 'notice', message: 'Этот конфликт уже разрешён.' });
    return true;
  }
  const key = String(message.key ?? '');
  const choice = String(message.choice ?? '');
  if (!key || !['collaborative', 'external'].includes(choice)) {
    throw new Error('Conflict resolution requires a key and a valid choice');
  }
  const pending = state.pendingExternal;
  if (!pending.conflicts?.some((conflict) => conflict.key === key)) {
    client.send({ type: 'notice', message: 'Сервер ещё не подтвердил этот конфликт.' });
    return true;
  }
  pending.resolutions.set(key, choice);
  pending.conflicts = null;
  void confirmDiskMerge(binding, client, absolutePath, state, pending,
    'Конфликты разрешены; итоговый файл подготовлен к сохранению.');
  return true;
}
