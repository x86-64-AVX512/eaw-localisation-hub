import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { TRACKED_PATH_PATTERN } from '../../../packages/shared/src/constants.mts';
import { documentControlAllowed } from '../../../packages/shared/src/document-permissions.mts';
import {
  localisationLanguage,
  readLocalisationLine,
  parseLocalisationRecords,
} from '../../../packages/shared/src/localisation-records.mts';
import {
  parseKeyReplacementBatch,
  scanLocalisationEntries,
} from '../../../packages/shared/src/localisation-replace.mts';
import { parseLocalisationKeys, withoutUtf8Bom } from '../../../packages/shared/src/text.mts';
import { createSuggestionAnchors } from './document-actions.mjs';
import { runGitAsync } from './git-executable.mts';
import { withCliDocument } from './cli-document.mjs';
import { CLI_UUID, CliError, cliDigest } from './cli-protocol.mjs';

const MAX_PLANS = 128;
const PLAN_MS = 15 * 60_000;

function required(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || value.includes('\0')) {
    throw new CliError('INVALID_ARGUMENT', `Invalid ${name}.`);
  }
  return value;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !CLI_UUID.test(value)) throw new CliError('INVALID_ARGUMENT', `Invalid ${name}.`);
  return value;
}

function keyArgument(value) {
  const key = required(value, 'localisation key', 512);
  if (!/^[A-Za-z0-9_.\-']+$/u.test(key)) throw new CliError('INVALID_ARGUMENT', 'Invalid localisation key.');
  return key;
}

function page(items, input) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new CliError('INVALID_ARGUMENT', 'Use a non-negative offset and a limit between 1 and 50.');
  }
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}

async function search(hub, input, signal) {
  const key = keyArgument(input.key);
  const language = input.lang === 'ru' ? 'russian' : input.lang === 'en' ? 'english' : input.lang;
  if (language && !['russian', 'english'].includes(language)) throw new CliError('INVALID_ARGUMENT', 'Use ru or en.');
  const result = await runGitAsync(['grep', '-n', '-z', '-I', '-F', '-e', `${key}:`, 'HEAD', '--', 'localisation'], {
    cwd: hub.options.repo,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000,
    signal,
  });
  signal.throwIfAborted();
  if (result.status !== 0 && result.status !== 1)
    throw new CliError('GIT_UNAVAILABLE', 'Could not search Git HEAD.', 503);
  const matches = [];
  for (const row of result.stdout.split(/\r?\n/u)) {
    const [name, number, line] = row.split('\0');
    const file = name.replace(/^HEAD:/u, '');
    if (!line || !TRACKED_PATH_PATTERN.test(file)) continue;
    const record = readLocalisationLine(line, Number(number));
    const foundLanguage = localisationLanguage(file);
    if (record?.key === key && (!language || language === foundLanguage)) {
      matches.push({ file, key, line: Number(number), language: foundLanguage });
    }
  }
  return { source: 'git-head', ...page(matches, input) };
}

async function target(hub, input, workspace) {
  const file = required(input.file, 'repository-relative file', 1024).replaceAll('\\', '/');
  if (path.isAbsolute(file) || /[:\u0000-\u001f\u007f]/u.test(file))
    throw new CliError('INVALID_PATH', 'Use a repository-relative path.');
  const ticketId = input.ticket ? identifier(input.ticket, 'ticket ID') : '';
  if (ticketId) {
    if (!TRACKED_PATH_PATTERN.test(file) || file.split('/').some((part) => !part || part === '.' || part === '..'))
      throw new CliError('INVALID_PATH', 'Use a path within the supported localisation folders.');
    return { relativePath: file, ticketId, workspace };
  }

  const root = hub.options.repo;
  const absolute = path.resolve(root, file);
  try {
    if (!TRACKED_PATH_PATTERN.test(path.relative(root, absolute).replaceAll('\\', '/'))) throw new Error();
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolute)]);
    const relativePath = path.relative(realRoot, realFile).replaceAll('\\', '/');
    if (!TRACKED_PATH_PATTERN.test(relativePath)) throw new Error();
    return { relativePath, ticketId, workspace };
  } catch {
    throw new CliError('INVALID_PATH', 'The localisation file is outside the repository or does not exist.');
  }
}

function locate(source, key) {
  const { entries, ambiguousEntries } = scanLocalisationEntries(source);
  const matches = entries.filter((item) => item.key === key);
  const candidates = parseLocalisationRecords(source).filter((item) => item.key === key);
  if (matches.length > 1 || candidates.length > 1 || ambiguousEntries.some((item) => item.key === key)) {
    throw new CliError('AMBIGUOUS_KEY', 'The key is duplicated or its quotes are ambiguous.', 409);
  }
  if (!matches.length)
    throw new CliError('KEY_NOT_FOUND', 'No readable value for this key exists in the shared document.', 404);
  return matches[0];
}

function lineRange(source, entry) {
  const newline = source.indexOf('\n', entry.end);
  return { start: source.lastIndexOf('\n', entry.start) + 1, end: newline === -1 ? source.length : newline };
}

function anchorRange(document, item) {
  if (item.orphaned) return null;
  try {
    const content = document.getText('content');
    const positions = [item.startRelative, item.endRelative].map((value) =>
      Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(value, 'base64')), document),
    );
    if (!positions.every((position) => position?.type === content)) return null;
    const [start, end] = positions.map((position) => position.index).sort((a, b) => a - b);
    return { start, end };
  } catch {
    return null;
  }
}

function reservationItems(document, source, snapshot, key, input) {
  const positions = key ? parseLocalisationKeys(source).filter((entry) => entry.key === key) : [];
  const items = [];
  for (const { startRelative, endRelative, color, ...item } of snapshot.reservations ?? []) {
    if (key) {
      const range = anchorRange(document, { startRelative, endRelative, orphaned: item.orphaned });
      const includesKey = range
        ? positions.some(({ index }) => index >= range.start && index < range.end)
        : item.initialKeys.includes(key);
      if (!includesKey) continue;
    }
    items.push(item);
  }
  return page(items, input);
}

function discussionItems(document, snapshot, line, input) {
  const items = [];
  for (const [kind, collection] of [
    ['comment', snapshot.commentThreads],
    ['suggestion', snapshot.suggestions],
  ]) {
    for (const item of collection ?? []) {
      if (input.id !== undefined && input.id !== item.id) continue;
      if (line) {
        const range = anchorRange(document, item);
        if (!range || Math.max(range.start + 1, range.end) <= line.start || range.start > line.end) continue;
      }
      const messages = (item.messages ?? []).filter((message) => !message.deleted);
      items.push({
        kind,
        id: item.id,
        status: item.status,
        author: item.author,
        createdAt: item.createdAt,
        originalText: item.originalText,
        replacementText: item.replacementText,
        messageCount: messages.length,
        messages: (input.id === undefined ? messages.slice(-10) : messages).map(
          ({ id, author, createdAt, body, revision }) => ({ id, author, createdAt, body, revision }),
        ),
      });
    }
  }
  return page(items, input);
}

async function readBaseline(hub, file, ticketId, signal) {
  let commit = 'HEAD';
  if (ticketId) {
    const { ticket } = await hub.ticketRequest(`/api/tickets/${ticketId}`, { method: 'GET', signal });
    if (!ticket?.files?.includes(file) || !/^[0-9a-f]{40,64}$/iu.test(ticket.baseCommit)) {
      throw new CliError('TICKET_FILE_UNAVAILABLE', 'The file or base commit is unavailable.', 404);
    }
    commit = ticket.baseCommit;
  }
  const result = await runGitAsync(['show', `${commit}:${file}`], {
    cwd: hub.options.repo,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 8000,
    signal,
  });
  signal.throwIfAborted();
  if (result.status !== 0) throw new CliError('GIT_UNAVAILABLE', 'Could not read the Git baseline.', 503);
  return withoutUtf8Bom(result.stdout);
}

function replacementFor(input, key, entry) {
  if (
    typeof input.text !== 'string' ||
    /[\0\r\n]/u.test(input.text) ||
    Buffer.byteLength(input.text) > 16 * 1024 ||
    Buffer.byteLength(entry.text) > 16 * 1024
  ) {
    throw new CliError(
      'INVALID_ARGUMENT',
      'Supply one localisation value within 16 KiB. Use literal \\n for an in-game newline.',
    );
  }
  const parsed = parseKeyReplacementBatch(`${key}:0 "${input.text}"`);
  const value = parsed.entries[0]?.text;
  if (parsed.errors.length || value === undefined)
    throw new CliError('INVALID_VALUE', 'The value has invalid quotation or escapes.');
  if (
    scanLocalisationEntries(`${key}:0 "${value}"`).entries[0]?.text !== value ||
    Buffer.byteLength(value) > 16 * 1024
  ) {
    throw new CliError('INVALID_VALUE', 'The encoded value exceeds the size limit or leaves an unclosed quote.');
  }
  if (value === entry.text) throw new CliError('NO_CHANGE', 'The proposed value is identical.');
  return value;
}

export function createCliCommands(hub) {
  const plans = new Map();
  const removeExpiredPlans = () => {
    for (const [id, item] of plans) if (item.expiresAt <= Date.now()) plans.delete(id);
  };

  async function execute(grant, input, assertGrant, signal) {
    if (input.command === 'status') {
      return {
        user: hub.identity.displayName,
        roles: hub.identity.roles,
        repository: hub.options.repo,
        workspace: hub.options.workspace,
        server: hub.options.server,
        serverVersion: hub.serverVersion || null,
        sessionConnected: hub.sessionSocket?.readyState === 1,
        access: grant.scope === 'propose' ? 'write' : 'read',
        expiresAt: new Date(grant.expiresAt).toISOString(),
      };
    }
    if (hub.workspaceTransitioning || hub.workspaceBlocked || hub.gitOperationInProgress?.()) {
      throw new CliError('WORKSPACE_BUSY', 'The Git workspace is switching or unavailable.', 409);
    }
    if (input.command === 'search') {
      return search(hub, input, signal);
    }
    if (input.command === 'tickets') {
      const { tickets } = await hub.ticketRequest('/api/tickets?archived=1', { method: 'GET', signal });
      return page(tickets, input);
    }
    if (input.command === 'ticket') {
      const id = identifier(input.id, 'ticket ID');
      return hub.ticketRequest(`/api/tickets/${id}`, { method: 'GET', signal });
    }
    const writing = ['submit', 'reply', 'comment', 'reserve'].includes(input.command);
    if ((writing || input.command === 'preview') && grant.scope !== 'propose') {
      throw new CliError('FORBIDDEN', 'This grant is read-only.', 403);
    }
    if (
      ![
        'read',
        'discussions',
        'preview',
        'submit',
        'reply',
        'comment',
        'reservations',
        'reserve',
        'history',
        'history-read',
      ].includes(input.command)
    ) {
      throw new CliError('UNKNOWN_COMMAND', 'Unknown CLI command.');
    }

    removeExpiredPlans();
    const planId = input.command === 'submit' ? identifier(input.plan, 'plan ID') : '';
    const plan = planId ? plans.get(planId) : null;
    if (planId && (!plan || plan.grantId !== grant.id))
      throw new CliError('PLAN_EXPIRED', 'Preview the suggestion again.', 404);
    const documentTarget = plan?.target ?? (await target(hub, input, hub.options.workspace));
    const { relativePath, workspace, ticketId } = documentTarget;
    const recheck = () => {
      signal.throwIfAborted();
      assertGrant();
      if (
        hub.options.workspace !== workspace ||
        hub.workspaceTransitioning ||
        hub.workspaceBlocked ||
        hub.gitOperationInProgress?.()
      ) {
        throw new CliError('WORKSPACE_CHANGED', 'The Git workspace has changed. Read the document again.', 409);
      }
    };
    recheck();
    const key = input.key !== undefined ? keyArgument(input.key) : null;
    const historyId = input.command === 'history-read' ? required(input.id, 'version ID', 128) : undefined;
    const result = await withCliDocument(
      hub,
      documentTarget,
      signal,
      async (document, snapshot, send) => {
        recheck();
        const text = document.getText('content');
        const location = { file: relativePath, workspace, ticket: ticketId || null };
        if (snapshot.initialised === false) {
          if (writing || input.command === 'preview') {
            throw new CliError(
              'DOCUMENT_NOT_INITIALISED',
              'Open the document in Review to initialise its shared text first.',
              409,
            );
          }
          const context = { ...location, revision: null, source: ticketId ? 'ticket-baseline' : 'git-head' };
          if (input.command !== 'read') {
            return { ...context, ...(input.command === 'history' ? { headId: null } : {}), ...page([], input) };
          }
          const baseline = await readBaseline(hub, relativePath, ticketId, signal);
          recheck();
          const entry = key ? locate(baseline, key) : null;
          return { ...context, ...(entry ? { key, line: entry.line, text: entry.text } : { text: baseline }) };
        }
        const source = text.toString();
        const documentId = `${ticketId ? `ticket-${ticketId}` : workspace}:${relativePath}`;
        const revision = cliDigest(`${documentId}\0${source}`);
        const entry = key && input.command !== 'reservations' ? locate(source, key) : null;
        const context = { ...location, revision, source: 'shared' };
        if (input.command === 'read')
          return { ...context, ...(entry ? { key, line: entry.line, text: entry.text } : { text: source }) };
        if (input.command === 'discussions')
          return { ...context, ...discussionItems(document, snapshot, entry ? lineRange(source, entry) : null, input) };
        if (input.command === 'reservations') {
          return { ...context, ...reservationItems(document, source, snapshot, key, input) };
        }
        if (input.command === 'history')
          return { ...context, headId: snapshot.historyHeadId || null, ...page(snapshot.history ?? [], input) };
        if (input.command === 'preview') {
          if (!entry) throw new CliError('INVALID_ARGUMENT', 'Pass --key to preview a value.');
          if (!documentControlAllowed(snapshot.identity, relativePath, 'suggestion-create')) {
            throw new CliError('FORBIDDEN', 'You cannot propose edits to this file.', 403);
          }
          const next = replacementFor(input, key, entry);
          if (plans.size >= MAX_PLANS) {
            const submitted = [...plans].find(([, candidate]) => candidate.submitted);
            if (!submitted) throw new CliError('BUSY', 'Too many pending previews.', 429);
            plans.delete(submitted[0]);
          }
          const id = randomUUID();
          const expiresAt = Math.min(Date.now() + PLAN_MS, grant.expiresAt);
          plans.set(id, {
            grantId: grant.id,
            submitted: false,
            target: documentTarget,
            expiresAt,
            revision,
            entry,
            next,
            anchors: createSuggestionAnchors(text, entry.start, entry.end),
          });
          return {
            ...context,
            key,
            line: entry.line,
            planId: id,
            expiresAt: new Date(expiresAt).toISOString(),
            diff: { before: entry.text, after: next },
          };
        }
        const requestId = planId || identifier(input.requestId, 'request ID');
        let payload;
        if (plan) {
          payload = {
            type: 'suggestion-create',
            id: planId,
            requestId,
            expectedRevision: plan.revision,
            originalText: plan.entry.text,
            replacementText: plan.next,
            ...(revision === plan.revision
              ? createSuggestionAnchors(text, plan.entry.start, plan.entry.end)
              : plan.anchors),
          };
        } else if (input.command === 'reserve') {
          if (!entry || Buffer.byteLength(key) > 256)
            throw new CliError('INVALID_ARGUMENT', 'Pass a key within 256 bytes.');
          if (
            input.text !== undefined &&
            (typeof input.text !== 'string' ||
              Buffer.byteLength(input.text) > 1024 ||
              /[\u0000-\u001f\u007f]/u.test(input.text))
          ) {
            throw new CliError(
              'INVALID_ARGUMENT',
              'Use a single-line reservation note without control characters, within 1024 bytes.',
            );
          }
          const { start, end } = lineRange(source, entry);
          payload = {
            type: 'reservation-create',
            id: requestId,
            requestId,
            comment: input.text ?? '',
            initialKeys: [key],
            expectedRevision: required(input.revision, 'shared revision from read', 64),
            ...createSuggestionAnchors(text, start, end),
          };
        } else {
          const body = required(input.text, 'discussion text', 2048);
          if (input.command === 'reply') {
            if (!['comment', 'suggestion'].includes(input.kind))
              throw new CliError('INVALID_ARGUMENT', 'Use --kind comment or suggestion.');
            payload = {
              type: `${input.kind}-reply`,
              id: required(input.id, 'discussion ID', 128),
              messageId: requestId,
              requestId,
              body,
            };
          } else {
            if (!entry) throw new CliError('INVALID_ARGUMENT', 'Pass --key to anchor the comment.');
            payload = {
              type: 'comment-create',
              id: requestId,
              messageId: requestId,
              requestId,
              body,
              expectedRevision: required(input.revision, 'shared revision from read', 64),
              ...createSuggestionAnchors(text, entry.start, entry.end),
            };
          }
        }
        if (!documentControlAllowed(snapshot.identity, relativePath, payload.type)) {
          throw new CliError('FORBIDDEN', 'This account cannot perform that operation on this file.', 403);
        }
        recheck();
        const acknowledgement = await send(payload);
        if (acknowledgement.status === 'stale')
          throw new CliError('STALE_REVISION', 'The document or requested operation changed. Read it again.', 409);
        if (acknowledgement.status === 'deleted') {
          const code =
            input.command === 'reserve'
              ? 'RESERVATION_DELETED'
              : input.command === 'submit'
                ? 'SUGGESTION_DELETED'
                : 'DISCUSSION_DELETED';
          const message =
            input.command === 'reserve'
              ? 'The reservation was deleted.'
              : input.command === 'submit'
                ? 'The suggestion was deleted.'
                : 'The discussion or message was deleted.';
          throw new CliError(code, message, 404);
        }
        if (acknowledgement.status !== 'saved') {
          const rejected = acknowledgement.code === 'WRITE_REJECTED';
          throw new CliError(
            rejected ? 'WRITE_REJECTED' : 'WRITE_UNCONFIRMED',
            acknowledgement.message ||
              (rejected ? 'The server rejected the change.' : 'The server did not confirm the write.'),
            rejected ? 409 : 503,
          );
        }
        if (plan) plan.submitted = true;
        return {
          ...context,
          id: payload.id,
          requestId,
          ...(payload.messageId ? { messageId: payload.messageId } : {}),
          status: 'saved',
        };
      },
      { writing, historyId, recheck },
    );
    if (historyId) return { file: relativePath, workspace, ticket: ticketId || null, ...result };
    if (input.command === 'read' && key && localisationLanguage(relativePath) !== 'english') {
      try {
        const original = await hub.englishOriginal(key, ticketId, signal);
        result.english = { commit: original.commit, matches: original.matches.slice(0, 20) };
      } catch {
        result.english = null;
      }
    }
    if (!writing) recheck();
    return result;
  }

  function removeGrant(grantId) {
    for (const [id, item] of plans) if (item.grantId === grantId) plans.delete(id);
  }

  return { execute, removeGrant };
}
