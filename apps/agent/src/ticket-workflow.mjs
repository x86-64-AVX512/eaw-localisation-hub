import path from 'node:path';
import { runGitSync } from './git-executable.mjs';
import { mergeLocalisationThreeWay } from '../../../packages/shared/src/merge.mjs';
import {
  readTrackedTextFile,
  withoutUtf8Bom,
} from '../../../packages/shared/src/text.mjs';

function decode(value) {
  return Buffer.from(String(value ?? ''), 'base64').toString('utf8');
}

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function gitText(repository, commit, relativePath) {
  const shown = runGitSync(['show', `${commit}:${relativePath}`], {
    cwd: repository, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (shown.status !== 0) throw new Error(`Файл ${relativePath} отсутствует в коммите ${commit.slice(0, 12)}.`);
  return withoutUtf8Bom(shown.stdout);
}

function changedLineCounts(before, after) {
  const counts = (text) => {
    const result = new Map();
    for (const line of text.split(/\r?\n/u)) result.set(line, (result.get(line) ?? 0) + 1);
    return result;
  };
  const left = counts(before);
  const right = counts(after);
  let added = 0;
  let removed = 0;
  for (const [line, count] of right) added += Math.max(0, count - (left.get(line) ?? 0));
  for (const [line, count] of left) removed += Math.max(0, count - (right.get(line) ?? 0));
  const keys = (text) => new Map(text.split(/\r?\n/u).map((line) => {
    const match = /^\s*([^#\s][^:]*?):\d+\s/u.exec(line);
    return match ? [match[1].trim(), line] : null;
  }).filter(Boolean));
  const beforeKeys = keys(before);
  const afterKeys = keys(after);
  const changedKeys = [...new Set([...beforeKeys.keys(), ...afterKeys.keys()])]
    .filter((key) => beforeKeys.get(key) !== afterKeys.get(key));
  return { added, removed, changedKeys: changedKeys.slice(0, 200) };
}

export class TicketWorkflow {
  constructor(hub) {
    this.hub = hub;
  }

  async snapshot(id, file = '') {
    const query = file ? `?file=${encodeURIComponent(file)}` : '';
    return this.hub.ticketRequest(`/api/tickets/${encodeURIComponent(id)}/snapshot${query}`, { method: 'GET' });
  }

  async markConflict(id, operation, conflicts) {
    await this.hub.ticketRequest(`/api/tickets/${encodeURIComponent(id)}/conflict`, {
      method: 'POST',
      body: JSON.stringify({ operation, files: conflicts.map((item) => item.path) }),
    });
    return { ok: false, conflicts };
  }

  async summary(id) {
    const snapshot = await this.snapshot(id);
    const files = snapshot.files.map((file) => {
      const base = gitText(this.hub.options.repo, snapshot.ticket.baseCommit, file.path);
      const ticket = file.ticketInitialised === false ? base : withoutUtf8Bom(decode(file.ticketTextBase64));
      return { path: file.path, ...changedLineCounts(base, ticket), changed: base !== ticket };
    });
    return { ticket: snapshot.ticket, files, totals: files.reduce((sum, file) => ({
      added: sum.added + file.added, removed: sum.removed + file.removed,
      changedFiles: sum.changedFiles + Number(file.changed),
    }), { added: 0, removed: 0, changedFiles: 0 }) };
  }

  async diff(id, requestedFile = '') {
    if (!requestedFile) {
      const payload = await this.hub.ticketRequest(`/api/tickets/${encodeURIComponent(id)}`, { method: 'GET' });
      return { ticket: payload.ticket, files: payload.ticket.files.map((file) => ({ path: file })) };
    }
    const snapshot = await this.snapshot(id, requestedFile);
    return {
      ticket: snapshot.ticket,
      files: snapshot.files.map((file) => {
        const base = gitText(this.hub.options.repo, snapshot.ticket.baseCommit, file.path);
        const ticket = file.ticketInitialised === false ? base : withoutUtf8Bom(decode(file.ticketTextBase64));
        return {
          path: file.path,
          baseTextBase64: encode(base),
          ticketTextBase64: encode(ticket),
          changed: base !== ticket,
        };
      }),
    };
  }

  async apply(id) {
    const snapshot = await this.snapshot(id);
    if (snapshot.ticket.baseBranch !== this.hub.options.workspace) {
      throw new Error(`Тикет относится к ветке ${snapshot.ticket.baseBranch}, а Agent запущен для ${this.hub.options.workspace}.`);
    }
    const results = [];
    const conflicts = [];
    for (const file of snapshot.files) {
      const base = gitText(this.hub.options.repo, snapshot.ticket.baseCommit, file.path);
      const ticket = file.ticketInitialised === false ? base : withoutUtf8Bom(decode(file.ticketTextBase64));
      const absolutePath = path.resolve(this.hub.options.repo, file.path);
      const collaborativeMain = file.mainInitialised === false
        ? base
        : withoutUtf8Bom(decode(file.mainTextBase64));
      const local = withoutUtf8Bom(await readTrackedTextFile(this.hub.options.repo, absolutePath));
      const mainMerge = mergeLocalisationThreeWay(base, collaborativeMain, local);
      const merge = mainMerge.conflicts.length
        ? mainMerge
        : mergeLocalisationThreeWay(base, ticket || base, mainMerge.text);
      if (merge.conflicts.length) {
        conflicts.push({ path: file.path, keys: merge.conflicts.map((item) => item.label) });
        continue;
      }
      results.push({
        path: file.path, ticketHash: file.ticketHash, mainHash: file.mainHash, textBase64: encode(merge.text),
      });
    }
    if (conflicts.length) return this.markConflict(id, 'apply', conflicts);
    const applied = await this.hub.ticketRequest(`/api/tickets/${encodeURIComponent(id)}/apply`, {
      method: 'POST', body: JSON.stringify({ results }),
    });
    for (const binding of this.hub.documents?.values?.() ?? []) binding.requestPersonalDocument?.();
    return { ok: true, ticket: applied.ticket, warnings: [] };
  }

  async rebase(id) {
    const snapshot = await this.snapshot(id);
    if (snapshot.ticket.baseBranch !== this.hub.options.workspace) {
      throw new Error(`Тикет относится к ветке ${snapshot.ticket.baseBranch}, а Agent запущен для ${this.hub.options.workspace}.`);
    }
    const baseCommit = this.hub.currentGitCommit();
    const results = [];
    const conflicts = [];
    for (const file of snapshot.files) {
      const oldBase = gitText(this.hub.options.repo, snapshot.ticket.baseCommit, file.path);
      const newBase = gitText(this.hub.options.repo, baseCommit, file.path);
      const ticket = file.ticketInitialised === false ? oldBase : withoutUtf8Bom(decode(file.ticketTextBase64));
      const merge = mergeLocalisationThreeWay(oldBase, ticket, newBase);
      if (merge.conflicts.length) {
        conflicts.push({ path: file.path, keys: merge.conflicts.map((item) => item.label) });
      } else {
        results.push({
          path: file.path, ticketHash: file.ticketHash, mainHash: file.mainHash, textBase64: encode(merge.text),
        });
      }
    }
    if (conflicts.length) return this.markConflict(id, 'rebase', conflicts);
    const rebased = await this.hub.ticketRequest(`/api/tickets/${encodeURIComponent(id)}/rebase`, {
      method: 'POST', body: JSON.stringify({
        baseBranch: this.hub.options.workspace, baseCommit, results,
      }),
    });
    return { ok: true, ticket: rebased.ticket };
  }
}
