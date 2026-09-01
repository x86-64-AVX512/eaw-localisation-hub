import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES } from '../../../packages/shared/src/constants.mjs';
import {
  normaliseTrackedPath,
  readTrackedTextFile,
  withoutUtf8Bom,
  withUtf8Bom,
  writeTrackedTextFile,
} from '../../../packages/shared/src/text.mjs';
import { validatePluginMessage } from '../../../packages/shared/src/protocol-schema.mjs';
import { handleTicketReviewApi } from './ticket-review-api.mjs';
import { persistentReviewEndpoint } from './review-endpoint.mjs';
import { fileHistoryDiff, listFileHistory } from './git-file-history.mjs';
import { runGitSync } from './git-executable.mjs';

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/editor.worker.js', ['editor.worker.js', 'text/javascript; charset=utf-8']],
]);

function tokenMatches(actual, expected) {
  const actualBytes = Buffer.from(String(actual ?? ''), 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function bearerToken(request) {
  const header = String(request.headers.authorization ?? '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function normaliseEnglishPath(repository, absolutePath) {
  const root = path.resolve(repository);
  const file = path.resolve(absolutePath);
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (!/^localisation\/english\/.+\.ya?ml$/iu.test(relative) || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('English file is outside localisation/english');
  }
  const canonicalRoot = fs.realpathSync.native(root);
  const canonicalFile = fs.realpathSync.native(file);
  const canonicalRelative = path.relative(canonicalRoot, canonicalFile).replaceAll('\\', '/');
  if (!canonicalRelative || canonicalRelative.startsWith('../') || path.isAbsolute(canonicalRelative)) {
    throw new Error('English file resolves outside the repository');
  }
  return relative;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function secureHeaders(response, contentType) {
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src 'self' ws://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
}

class ReviewClient {
  constructor(socket, hub) {
    this.websocket = socket;
    this.hub = hub;
    this.clientId = `review-${process.pid}-${crypto.randomUUID()}`;
    this.kind = 'review';
    this.documents = new Map();
    this.activeDocumentPath = null;
    this.authenticated = true;
    this.closed = false;
    this.materialisationTimers = new Map();
    this.socket = { destroy: () => socket.terminate() };
    socket.on('message', (data, binary) => this.receive(data, binary));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }

  receive(data, binary) {
    if (binary || data.length > MAX_MESSAGE_BYTES) {
      this.websocket.close(1009, 'Message too large');
      return;
    }
    try {
      const message = validatePluginMessage(JSON.parse(data.toString('utf8')));
      this.hub.receivePluginMessage(this, message);
      if (['edit', 'snapshot', 'undo', 'redo', 'suggestionAccept', 'suggestionRevert', 'historyRestore', 'externalConflictResolve'].includes(message.type)) {
        this.scheduleMaterialisation(message.path);
      }
    } catch {
      this.send({ type: 'error', message: 'Некорректная команда Review-клиента.' });
      this.websocket.close(1008, 'Invalid command');
    }
  }

  send(message) {
    if (this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(message));
    }
    if (message.type === 'replace' || message.type === 'saveRequested') {
      this.scheduleMaterialisation(message.path);
    }
  }

  scheduleMaterialisation(absolutePath) {
    if (!absolutePath) return;
    clearTimeout(this.materialisationTimers.get(absolutePath));
    const timer = setTimeout(async () => {
      this.materialisationTimers.delete(absolutePath);
      const state = this.documents.get(path.resolve(absolutePath));
      if (!state?.initialised || state.binding.gitWritable === false || state.pendingExternal
        || state.binding.ticketId || this.hub.workspaceBlocked) return;
      const materialised = typeof state.binding.localFileText === 'function'
        ? state.binding.localFileText() : state.binding.text.toString();
      state.materialisationExpected = materialised;
      state.materialisationDeadline = Date.now() + 5000;
      state.materialisationMismatch = null;
      try {
        await writeTrackedTextFile(this.hub.options.repo, absolutePath, withUtf8Bom(materialised));
      } catch {
        this.send({ type: 'error', message: 'Не удалось безопасно сохранить локальный файл.' });
      }
    }, 500);
    timer.unref();
    this.materialisationTimers.set(absolutePath, timer);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.materialisationTimers.values()) clearTimeout(timer);
    this.materialisationTimers.clear();
    this.hub.detachClient(this);
  }
}

async function writeDiscovery(options, value) {
  const discoveryPath = path.join(options.state, 'review-session.json');
  await fsPromises.mkdir(path.dirname(discoveryPath), { recursive: true });
  const temporary = `${discoveryPath}.${process.pid}.tmp`;
  await fsPromises.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsPromises.chmod(temporary, 0o600).catch(() => {});
  await fsPromises.rename(temporary, discoveryPath);
  await fsPromises.chmod(discoveryPath, 0o600).catch(() => {});
  return discoveryPath;
}

function requestIsLoopback(request, port) {
  const host = String(request.headers.host ?? '').toLowerCase();
  return host === `127.0.0.1:${port}` && request.socket.remoteAddress === '127.0.0.1';
}

export async function startReviewServer(hub, options) {
  const endpoint = await persistentReviewEndpoint(options);
  const { token, port: preferredPort } = endpoint;
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'review-web');
  const server = http.createServer(async (request, response) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!requestIsLoopback(request, port)) {
      response.writeHead(403).end();
      return;
    }
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (requestUrl.pathname === '/api/bootstrap') {
      if (!tokenMatches(bearerToken(request), token)) {
        response.writeHead(401).end();
        return;
      }
      try {
        const requested = requestUrl.searchParams.get('path') ?? '';
        const absolutePath = path.resolve(options.repo, requested);
        const englishReadOnly = requestUrl.searchParams.get('readonly') === 'english';
        const relativePath = englishReadOnly
          ? normaliseEnglishPath(options.repo, absolutePath)
          : normaliseTrackedPath(options.repo, absolutePath);
        const ticketId = requestUrl.searchParams.get('ticket') ?? '';
        const ticketBootstrap = !englishReadOnly && ticketId ? await hub.ticketBootstrap(ticketId, relativePath) : null;
        let text;
        if (englishReadOnly && requestUrl.searchParams.get('commit')) {
          const commit = requestUrl.searchParams.get('commit');
          if (!/^[0-9a-f]{40,64}$/iu.test(commit)) throw new Error('Invalid English commit');
          const shown = runGitSync(['show', `${commit}:${relativePath}`], {
            cwd: options.repo, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
          });
          if (shown.status !== 0) throw new Error('English file is unavailable in the selected commit');
          text = withoutUtf8Bom(shown.stdout);
        } else {
          text = englishReadOnly
            ? withoutUtf8Bom(await fsPromises.readFile(absolutePath, 'utf8'))
            : ticketBootstrap?.text ?? withoutUtf8Bom(await readTrackedTextFile(options.repo, absolutePath));
        }
        secureHeaders(response, 'application/json; charset=utf-8');
        response.end(JSON.stringify({
          path: absolutePath,
          relativePath,
          workspace: options.workspace,
          ticket: ticketBootstrap?.ticket ?? null,
          user: options.user,
          color: options.color,
          readOnly: englishReadOnly,
          textBase64: Buffer.from(text, 'utf8').toString('base64'),
        }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message
          || 'Файл не входит в поддерживаемые папки localisation текущего репозитория.' }));
      }
      return;
    }
    if (requestUrl.pathname === '/api/git-history' && request.method === 'GET') {
      if (!tokenMatches(bearerToken(request), token)) { response.writeHead(401).end(); return; }
      try {
        const requested = requestUrl.searchParams.get('path') ?? '';
        const absolutePath = path.resolve(options.repo, requested);
        const relativePath = normaliseTrackedPath(options.repo, absolutePath);
        const payload = listFileHistory(options.repo, relativePath, {
          offset: Number(requestUrl.searchParams.get('offset') ?? 0),
          limit: Number(requestUrl.searchParams.get('limit') ?? 50),
        });
        secureHeaders(response, 'application/json; charset=utf-8');
        response.end(JSON.stringify(payload));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (requestUrl.pathname === '/api/git-history/diff' && request.method === 'GET') {
      if (!tokenMatches(bearerToken(request), token)) { response.writeHead(401).end(); return; }
      try {
        const requested = requestUrl.searchParams.get('path') ?? '';
        const absolutePath = path.resolve(options.repo, requested);
        const relativePath = normaliseTrackedPath(options.repo, absolutePath);
        const fromCommit = requestUrl.searchParams.get('from')
          ?? requestUrl.searchParams.get('commit') ?? '';
        const toCommit = requestUrl.searchParams.get('to') ?? 'HEAD';
        const payload = fileHistoryDiff(
          options.repo,
          relativePath,
          fromCommit,
          requestUrl.searchParams.get('fromPath')
            ?? requestUrl.searchParams.get('historicalPath') ?? relativePath,
          toCommit,
          requestUrl.searchParams.get('toPath') ?? relativePath,
        );
        secureHeaders(response, 'application/json; charset=utf-8');
        response.end(JSON.stringify({
          ...payload,
          baseText: undefined,
          headText: undefined,
          baseBase64: Buffer.from(payload.baseText, 'utf8').toString('base64'),
          headBase64: Buffer.from(payload.headText, 'utf8').toString('base64'),
        }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (await handleTicketReviewApi({
      request, requestUrl, response,
      authorised: () => tokenMatches(bearerToken(request), token),
      hub, options, readJsonBody, secureHeaders,
    })) return;
    if (requestUrl.pathname === '/api/english-open' && request.method === 'POST') {
      if (!tokenMatches(bearerToken(request), token)) { response.writeHead(401).end(); return; }
      try {
        const body = await readJsonBody(request);
        const payload = await hub.englishOriginal(body.key ?? '', body.ticket ?? '');
        const match = payload.matches?.[0];
        if (!match) throw new Error('В английской локализации этот ключ не найден.');
        await options.reviewOpen(match.file, {
          readOnly: 'english', commit: payload.commit, pair: String(body.pair ?? ''), line: match.line,
        });
        secureHeaders(response, 'application/json; charset=utf-8');
        response.end(JSON.stringify({ file: match.file, line: match.line }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (requestUrl.pathname === '/api/key-replacements/preview' && request.method === 'POST') {
      if (!tokenMatches(bearerToken(request), token)) { response.writeHead(401).end(); return; }
      try {
        const body = await readJsonBody(request);
        const payload = await hub.keyReplacementWorkflow.preview(body.input ?? '');
        secureHeaders(response, 'application/json; charset=utf-8');
        response.end(JSON.stringify(payload));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (requestUrl.pathname === '/api/key-replacements/apply' && request.method === 'POST') {
      if (!tokenMatches(bearerToken(request), token)) { response.writeHead(401).end(); return; }
      try {
        const body = await readJsonBody(request);
        const payload = await hub.keyReplacementWorkflow.apply(body.input ?? '', body.files);
        secureHeaders(response, 'application/json; charset=utf-8');
        response.end(JSON.stringify(payload));
      } catch (error) {
        response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (requestUrl.pathname === '/api/english-original' && request.method === 'GET') {
      if (!tokenMatches(bearerToken(request), token)) {
        response.writeHead(401).end();
        return;
      }
      try {
        const payload = await hub.englishOriginal(
          requestUrl.searchParams.get('key') ?? '',
          requestUrl.searchParams.get('ticket') ?? '',
        );
        secureHeaders(response, 'application/json; charset=utf-8');
        response.end(JSON.stringify(payload));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    const asset = STATIC_FILES.get(requestUrl.pathname);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    try {
      const [name, type] = asset;
      const body = await fsPromises.readFile(path.join(webRoot, name));
      secureHeaders(response, type);
      response.end(body);
    } catch {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Review application assets are not built.');
    }
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on('upgrade', (request, socket, head) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      socket.destroy();
      return;
    }
    const correctOrigin = request.headers.origin === `http://127.0.0.1:${port}`;
    if (!requestIsLoopback(request, port)
      || requestUrl.pathname !== '/review-socket'
      || !correctOrigin
      || !tokenMatches(requestUrl.searchParams.get('token'), token)) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const client = new ReviewClient(websocket, hub);
      if (!hub.attachAuthenticatedClient(client)) websocket.close(1013, 'Too many local clients');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const discoveryPath = await writeDiscovery(options, {
    schema: 1,
    pid: process.pid,
    origin: `http://127.0.0.1:${port}`,
    token,
    repository: options.repo,
    workspace: options.workspace,
  });
  const open = async (requestedPath, openOptions = {}) => {
    const absolutePath = path.resolve(options.repo, requestedPath);
    if (openOptions.readOnly === 'english') {
      normaliseEnglishPath(options.repo, absolutePath);
    } else {
      normaliseTrackedPath(options.repo, absolutePath);
      await readTrackedTextFile(options.repo, absolutePath);
    }
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.EAW_HUB_REVIEW_HOST,
      path.resolve(moduleDirectory, '..', '..', '..', 'dist', 'EawReview', 'EaWReview.exe'),
      path.resolve(moduleDirectory, '..', '..', '..', 'review', 'EaWReview.exe'),
    ].filter(Boolean);
    const host = candidates.find((candidate) => fs.existsSync(candidate));
    if (!host) throw new Error('EaWReview.exe is missing');
    const hash = new URLSearchParams({ token, path: absolutePath });
    for (const [name, value] of Object.entries(openOptions)) if (value !== undefined && value !== '') hash.set(name, String(value));
    const url = `http://127.0.0.1:${port}/#${hash}`;
    const child = spawn(host, [url], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  };
  return {
    discoveryPath,
    open,
    async close() {
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      await new Promise((resolve) => server.close(resolve));
      await fsPromises.rm(discoveryPath, { force: true }).catch(() => {});
    },
  };
}
