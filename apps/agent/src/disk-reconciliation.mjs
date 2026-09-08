import fs from 'node:fs';
import path from 'node:path';
import {
  computeSingleReplace,
  normaliseTrackedPath,
  normaliseLineEndings,
  readTrackedTextFile,
  withoutUtf8Bom,
  utf8ByteOffsetToUtf16Index,
} from '../../../packages/shared/src/text.mjs';
import { mergeLocalisationThreeWay } from '../../../packages/shared/src/merge.mjs';

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

function mergeDiskCopies(binding, baseText, externalText, resolutions = new Map()) {
  const personalText = binding.localFileText();
  return {
    shared: mergeLocalisationThreeWay(
      baseText, binding.text.toString(), externalText, resolutions,
    ),
    personal: personalText === null ? null : mergeLocalisationThreeWay(
      baseText, personalText, externalText, resolutions,
    ),
  };
}

function diskMergeConflicts(merges) {
  const conflicts = new Map();
  for (const conflict of merges.shared.conflicts) conflicts.set(conflict.key, conflict);
  for (const conflict of merges.personal?.conflicts ?? []) {
    if (!conflicts.has(conflict.key)) conflicts.set(conflict.key, conflict);
  }
  return [...conflicts.values()];
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
  if (binding.ticketId) return;
  if (binding.paused || state.binding !== binding || !client.documents.has(absolutePath)) return;
  if (binding.hub.gitOperationInProgress?.()) {
    binding.scheduleDiskCheck(client, absolutePath, state, 300);
    return;
  }
  const externalText = await binding.readDiskText(absolutePath);
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

  const merges = mergeDiskCopies(binding, state.diskBase, externalText);
  const conflicts = diskMergeConflicts(merges);
  if (conflicts.length > 0) {
    state.pendingExternal = {
      base: state.diskBase,
      external: externalText,
      resolutions: new Map(),
    };
    binding.emitExternalConflicts(client, absolutePath, state, conflicts);
    client.send({
      type: 'notice',
      message: `GitHub Desktop изменил файл: требуется разрешить конфликтов – ${conflicts.length}.`,
    });
    return;
  }

  binding.finishExternalMerge(
    client, absolutePath, state, merges.shared.text, merges.personal.text,
    'Изменения с диска объединены с совместным документом.',
  );
}

export function persistBaseSnapshot(binding, state, text) {
  state.hasPersistedBase = true;
  state.basePersistPromise = state.basePersistPromise
    .catch(() => {})
    .then(() => binding.hub.saveBaseSnapshot(binding.relativePath, text))
    .catch(() => console.error('[agent] could not persist a merge base'));
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
    binding.emitExternalConflicts(client, absolutePath, state);
    client.send({
      type: 'notice',
      message: 'Нет сохранённой базы слияния: выберите текущую совместную версию или локальный файл Git.',
    });
    return;
  }

  const merges = mergeDiskCopies(binding, state.diskBase, localText);
  const conflicts = diskMergeConflicts(merges);
  if (conflicts.length > 0) {
    state.pendingExternal = {
      base: state.diskBase,
      external: localText,
      resolutions: new Map(),
    };
    binding.emitExternalConflicts(client, absolutePath, state, conflicts);
    client.send({
      type: 'notice',
      message: `После запуска найдены конфликты между Git и совместной сессией: ${conflicts.length}.`,
    });
    return;
  }

  if (localText === merges.personal.text) {
    state.diskBase = merges.personal.text;
    binding.applyMergedText(merges.shared.text);
    binding.persistBaseSnapshot(state, merges.personal.text);
    return;
  }
  binding.finishExternalMerge(
    client,
    absolutePath,
    state,
    merges.shared.text,
    merges.personal.text,
    'Локальный Git-файл согласован с совместной сессией после запуска.',
  );
}

export function emitExternalConflicts(binding, client, absolutePath, state, knownConflicts = null) {
  client.send({ type: 'externalConflictReset', path: absolutePath, source: 'disk' });
  if (!state.pendingExternal) return;
  if (state.pendingExternal.initialUnknown) {
    client.send({
      type: 'externalConflict',
      path: absolutePath,
      source: 'disk',
      key: '__initial_state__',
      label: 'Начальная версия файла',
      detail: 'База слияния ещё не создана. Выберите совместную версию или локальный файл Git.',
      baseLine: '', collaborativeLine: conflictText(binding.text.toString()),
      externalLine: conflictText(state.pendingExternal.external),
    });
    return;
  }
  const conflicts = knownConflicts ?? diskMergeConflicts(mergeDiskCopies(
    binding,
    state.pendingExternal.base,
    state.pendingExternal.external,
    state.pendingExternal.resolutions,
  ));
  for (const conflict of conflicts) {
    let detail = 'Один и тот же ключ изменён совместно и на диске.';
    if (conflict.key === '__file_structure__') detail = 'Комментарии или структура файла изменены с обеих сторон.';
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
  if (state.pendingExternal.initialUnknown) {
    if (key !== '__initial_state__') throw new Error('Unexpected initial-state conflict key');
    const currentPersonal = binding.localFileText();
    if (currentPersonal === null) {
      client.send({ type: 'notice', message: 'Личная версия ещё обновляется. Повторите выбор после синхронизации.' });
      return true;
    }
    const personalText = choice === 'external'
      ? state.pendingExternal.external
      : currentPersonal;
    const sharedText = choice === 'external'
      ? state.pendingExternal.external
      : binding.text.toString();
    binding.finishExternalMerge(
      client,
      absolutePath,
      state,
      sharedText,
      personalText,
      'Начальная база слияния создана; выбранная версия будет сохранена.',
    );
    return true;
  }
  state.pendingExternal.resolutions.set(key, choice);
  const merges = mergeDiskCopies(
    binding, state.pendingExternal.base, state.pendingExternal.external,
    state.pendingExternal.resolutions,
  );
  if (merges.personal === null) {
    client.send({ type: 'notice', message: 'Личная версия ещё обновляется. Повторите выбор после синхронизации.' });
    return true;
  }
  const conflicts = diskMergeConflicts(merges);
  if (conflicts.length > 0) {
    binding.emitExternalConflicts(client, absolutePath, state, conflicts);
    return true;
  }
  binding.finishExternalMerge(
    client,
    absolutePath,
    state,
    merges.shared.text,
    merges.personal.text,
    'Конфликты разрешены; итоговый файл подготовлен к сохранению.',
  );
  return true;
}
