import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
  clearTrackedLineEndingPreferences, computeSingleReplace, normaliseLineEndings,
  readTrackedTextFile, withoutUtf8Bom,
} from '../../../packages/shared/src/text.mjs';
import { DocumentBinding } from './document-binding.mjs';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForGitCheckout(hub, nextWorkspace, options = {}) {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 20_000;
  const quietMilliseconds = options.quietMilliseconds ?? 500;
  const pollMilliseconds = options.pollMilliseconds ?? 50;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const deadline = now() + timeoutMilliseconds;
  let stableSignature = '';
  let stableSince = null;
  while (now() <= deadline) {
    const observation = hub.gitCheckoutObservation();
    const eligible = observation.workspace === nextWorkspace
      && Boolean(observation.commit) && !observation.locked;
    const signature = eligible
      ? `${observation.workspace}:${observation.commit}:${observation.indexFingerprint}` : '';
    if (!signature || signature !== stableSignature) {
      stableSignature = signature;
      stableSince = signature ? now() : null;
    } else if (stableSince !== null && now() - stableSince >= quietMilliseconds) {
      return observation;
    }
    await sleep(pollMilliseconds);
  }
  throw new Error(`Git checkout did not settle for branch ${nextWorkspace}`);
}

async function saveUnsynchronisedBuffer(hub, snapshot, previousWorkspace) {
  if (snapshot.ticketId || snapshot.mirror === snapshot.diskBase) return '';
  const directory = path.join(hub.options.state, 'git-recovery', 'workspace-switch');
  await fs.mkdir(directory, { recursive: true });
  const identity = crypto.createHash('sha256')
    .update(`${previousWorkspace}:${snapshot.path}:${Date.now()}:${snapshot.client.clientId}`)
    .digest('hex').slice(0, 16);
  const savedPath = path.join(directory, `${path.basename(snapshot.path)}.${identity}.yml`);
  await fs.writeFile(savedPath, snapshot.mirror, 'utf8');
  return savedPath;
}

function replaceClientText(snapshot, nextText) {
  const replacement = computeSingleReplace(snapshot.mirror, nextText);
  if (!replacement) return;
  snapshot.client.send({
    type: 'replace', path: snapshot.path,
    positionByte: replacement.positionByte,
    deleteBytes: replacement.deleteBytes,
    insertBase64: Buffer.from(replacement.insertText, 'utf8').toString('base64'),
    source: 'workspace',
  });
}

export async function transitionWorkspace(hub, nextWorkspace) {
  const previousWorkspace = hub.options.workspace;
  if (!nextWorkspace || nextWorkspace === previousWorkspace) return;
  const snapshots = [];
  for (const client of hub.clients) {
    for (const [absolutePath, state] of client.documents) snapshots.push({
      client, path: absolutePath, mirror: state.mirror,
      diskBase: state.diskBase, ticketId: state.binding.ticketId,
    });
    for (const snapshot of client.workspaceUnavailableDocuments?.values() ?? []) {
      if (!snapshots.some((item) => item.client === client && item.path === snapshot.path)) {
        snapshots.push({ ...snapshot, client });
      }
    }
  }

  for (const client of hub.clients) client.send({
    type: 'workspaceChanged', phase: 'switching', previousWorkspace, workspace: nextWorkspace,
    message: `Git-ветка переключается: ${previousWorkspace} → ${nextWorkspace}. Документы временно доступны только для чтения.`,
  });
  for (const snapshot of snapshots) snapshot.client.send({
    type: 'externalConflictReset', path: snapshot.path,
  });
  const bindings = [...hub.documents.values()];
  for (const binding of bindings) binding.paused = true;
  await waitForGitCheckout(hub, nextWorkspace);
  clearTrackedLineEndingPreferences();
  for (const binding of bindings) {
    for (const client of [...binding.clients]) binding.detach(client);
  }
  hub.documents.clear();
  await Promise.allSettled(bindings.map((binding) => binding.close()));

  hub.options.workspace = nextWorkspace;
  hub.detectedWorkspace = nextWorkspace;
  hub.gitCommit = hub.currentDocumentGitCommit();
  for (const client of hub.clients) if (client.authenticated) hub.sendAgentHello(client);

  for (const snapshot of snapshots) {
    if (snapshot.client.closed) continue;
    let initialText = snapshot.mirror;
    if (!snapshot.ticketId) {
      try {
        initialText = normaliseLineEndings(withoutUtf8Bom(
          await readTrackedTextFile(hub.options.repo, snapshot.path),
        ));
      } catch (error) {
        snapshot.client.send({
          type: 'documentStatus', path: snapshot.path, status: 'file-unavailable',
          message: `Файл отсутствует в ветке ${nextWorkspace}: ${path.basename(snapshot.path)}.`,
        });
        snapshot.client.workspaceUnavailableDocuments ??= new Map();
        snapshot.client.workspaceUnavailableDocuments.set(snapshot.path, {
          path: snapshot.path, mirror: snapshot.mirror,
          diskBase: snapshot.diskBase, ticketId: snapshot.ticketId,
        });
        continue;
      }
      const savedPath = await saveUnsynchronisedBuffer(hub, snapshot, previousWorkspace);
      if (savedPath) snapshot.client.send({
        type: 'notice', message: `Несохранённый буфер прежней ветки сохранён: ${savedPath}`,
      });
      replaceClientText(snapshot, initialText);
    }
    snapshot.client.workspaceUnavailableDocuments?.delete(snapshot.path);
    const relativePath = path.relative(hub.options.repo, snapshot.path).replaceAll('\\', '/');
    const namespace = snapshot.ticketId ? `ticket-${snapshot.ticketId}` : nextWorkspace;
    const documentId = `${namespace}:${relativePath}`;
    let binding = hub.documents.get(documentId);
    if (!binding) {
      binding = new DocumentBinding(hub, documentId, relativePath, snapshot.ticketId);
      hub.documents.set(documentId, binding);
    }
    binding.attach(snapshot.client, snapshot.path, initialText);
  }
  for (const client of hub.clients) client.send({
    type: 'workspaceChanged', phase: 'ready', previousWorkspace, workspace: nextWorkspace,
    message: `Git-ветка переключена на ${nextWorkspace}. Открытые документы переподключаются автоматически.`,
  });
}
