import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CLI_ROUTE, CLI_UUID, CliError, cliDigest, cliProof, parseCliToken } from './cli-protocol.mjs';
import { createCliCommands } from './cli-commands.mjs';

const MAX_GRANTS = 16;
const MAX_REQUESTS = 4;

export async function createCliApi(hub, stateDirectory) {
  const grants = new Map();
  const commands = createCliCommands(hub);
  const settingsPath = path.join(stateDirectory, 'cli-access.json');
  const modes = ['off', 'read', 'write'];
  let mode = 'off';
  try {
    const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'))?.mode;
    if (modes.includes(saved)) mode = saved;
  } catch {
    // A missing or unreadable configuration must never enable access.
  }
  let settingsRevision = 0;
  let settingsQueue = Promise.resolve();
  let activeRequests = 0;
  let pendingManagement = 0;
  let closed = false;

  function revoke(grant) {
    if (!grant) return;
    grants.delete(grant.id);
    clearTimeout(grant.timer);
    grant.controller.abort(new CliError('GRANT_REVOKED', 'This grant has expired or was revoked.', 401));
    commands.removeGrant(grant.id);
  }

  function clear() {
    for (const grant of grants.values()) revoke(grant);
  }

  function lookup(id) {
    const grant = grants.get(id);
    if (
      grant &&
      (mode === 'off' ||
        grant.expiresAt <= Date.now() ||
        grant.session !== hub.sessionRevision ||
        grant.account !== hub.identity?.id ||
        hub.reviewAccess !== 'allowed')
    ) {
      revoke(grant);
      return undefined;
    }
    return grant;
  }

  function describe({ id, scope, expiresAt, label }) {
    return { id, scope, expiresAt: new Date(expiresAt).toISOString(), label };
  }

  function settings() {
    return { mode, grants: [...grants.keys()].map(lookup).filter(Boolean).map(describe) };
  }

  function requireEnabled() {
    if (mode === 'off') throw new CliError('CLI_DISABLED', 'Enable CLI access in Desktop Agent.', 403);
  }

  function changeSettings(value) {
    if (!modes.includes(value)) throw new CliError('INVALID_ARGUMENT', 'Expected off, read or write.');
    const operation = settingsQueue.then(async () => {
      if (value === mode) return settings();
      const temporary = `${settingsPath}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(stateDirectory, { recursive: true });
        await fs.writeFile(temporary, JSON.stringify({ mode: value }), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, settingsPath);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      mode = value;
      settingsRevision++;
      if (mode === 'off') clear();
      if (mode === 'read') {
        for (const grant of grants.values()) {
          if (grant.scope !== 'propose') continue;
          grant.scope = 'read';
          grant.writeController.abort(new CliError('READ_ONLY', 'CLI is now read-only.', 403));
          commands.removeGrant(grant.id);
        }
      }
      return settings();
    });
    settingsQueue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  async function manage(method, body, port, signal) {
    if (method === 'GET') return { grants: [...grants.keys()].map(lookup).filter(Boolean).map(describe) };
    if (method === 'DELETE') {
      if (typeof body?.id !== 'string' || !CLI_UUID.test(body.id))
        throw new CliError('INVALID_ARGUMENT', 'Invalid grant ID.');
      revoke(grants.get(body.id));
      return { revoked: true };
    }
    if (method !== 'POST') throw new CliError('UNKNOWN_COMMAND', 'Unsupported method.', 405);
    requireEnabled();
    const revision = settingsRevision;
    const initialAccount = hub.identity?.id ?? '';
    const initialSession = hub.sessionRevision;
    if (pendingManagement >= MAX_REQUESTS) throw new CliError('BUSY', 'Too many grant requests.', 429);
    pendingManagement++;
    try {
      await hub.requireReviewAccess();
    } catch {
      throw new CliError('SIGN_IN_REQUIRED', 'Sign in to Desktop Agent first.', 401);
    } finally {
      pendingManagement--;
    }
    signal.throwIfAborted();
    requireEnabled();
    if (revision !== settingsRevision)
      throw new CliError('CLI_SETTING_CHANGED', 'CLI settings changed during this request.', 409);
    if (initialAccount && (hub.identity?.id !== initialAccount || hub.sessionRevision !== initialSession)) {
      throw new CliError('ACCOUNT_CHANGED', 'The signed-in account changed during this request. Try again.', 409);
    }
    if (closed || hub.reviewAccess !== 'allowed' || !hub.identity?.id || !hub.options.token) {
      throw new CliError('SIGN_IN_REQUIRED', 'Sign in to Desktop Agent and connect to the Hub first.', 401);
    }
    if (
      !body ||
      ![15, 60, 240].includes(body.minutes) ||
      typeof body.label !== 'string' ||
      !body.label.trim() ||
      body.label.length > 80 ||
      /[\u0000-\u001f]/u.test(body.label)
    )
      throw new CliError('INVALID_ARGUMENT', 'Invalid expiry or label.');
    for (const id of grants.keys()) lookup(id);
    if (grants.size >= MAX_GRANTS) throw new CliError('BUSY', 'Revoke an existing grant first.', 429);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const grant = {
      id,
      digest: cliDigest(secret),
      scope: mode === 'write' ? 'propose' : 'read',
      label: body.label,
      account: hub.identity.id,
      session: hub.sessionRevision,
      expiresAt: Date.now() + body.minutes * 60_000,
      controller: new AbortController(),
      writeController: new AbortController(),
    };
    grant.timer = setTimeout(() => revoke(grant), body.minutes * 60_000);
    grant.timer.unref();
    grants.set(id, grant);
    return { ...describe(grant), token: `eaw1.${port}.${id}.${secret}`, repository: hub.options.repo };
  }

  async function handle(request, response, url, { port, reviewAuthorised, bearer, readJsonBody, secureHeaders }) {
    if (!url.pathname.startsWith(CLI_ROUTE)) return false;
    secureHeaders(response, 'application/json; charset=utf-8');
    const json = (status, payload) => response.writeHead(status).end(JSON.stringify(payload));
    let requestId;
    let charged = false;
    const aborted = new AbortController();
    const onClose = () => aborted.abort(new CliError('DISCONNECTED', 'The CLI disconnected.', 499));
    response.once('close', onClose);
    try {
      if (closed) throw new CliError('AGENT_STOPPING', 'Desktop Agent is stopping.', 503);
      if (request.headers.origin || request.headers['sec-fetch-site']) {
        throw new CliError('FORBIDDEN', 'The CLI API accepts local application requests only.', 403);
      }
      if (url.pathname === `${CLI_ROUTE}settings` || url.pathname === `${CLI_ROUTE}grants`) {
        if (!reviewAuthorised()) throw new CliError('FORBIDDEN', 'Desktop Agent authorisation is required.', 403);
        if (url.pathname.endsWith('/settings')) {
          if (request.method === 'GET') json(200, { ok: true, data: settings() });
          else if (request.method === 'PUT') {
            const body = await readJsonBody(request, 2048);
            json(200, { ok: true, data: await changeSettings(body?.mode) });
          } else throw new CliError('UNKNOWN_COMMAND', 'Unsupported method.', 405);
          return true;
        }
        const body = request.method === 'GET' ? undefined : await readJsonBody(request, 2048);
        json(200, { ok: true, data: await manage(request.method, body, port, aborted.signal) });
        return true;
      }
      requireEnabled();
      if (url.pathname === `${CLI_ROUTE}owner` && request.method === 'HEAD') {
        const id = url.searchParams.get('id') ?? '';
        const nonce = url.searchParams.get('nonce') ?? '';
        const grant = CLI_UUID.test(id) && /^[0-9a-f]{32}$/u.test(nonce) ? lookup(id) : null;
        if (grant) response.writeHead(204, { 'X-EaW-CLI-Owner': cliProof(grant.digest, id, nonce) }).end();
        else response.writeHead(401).end();
        return true;
      }
      if (url.pathname !== `${CLI_ROUTE}command` || request.method !== 'POST') {
        throw new CliError('UNKNOWN_COMMAND', 'Unknown CLI route.', 404);
      }
      const parsed = parseCliToken(bearer);
      const grant = parsed?.port === port ? lookup(parsed.id) : undefined;
      if (!grant || !timingSafeEqual(Buffer.from(grant.digest, 'hex'), Buffer.from(cliDigest(parsed.secret), 'hex'))) {
        throw new CliError('GRANT_REQUIRED', 'A valid CLI grant is required.', 401);
      }
      if (activeRequests >= MAX_REQUESTS) throw new CliError('BUSY', 'Wait for other CLI requests to finish.', 429);
      activeRequests++;
      charged = true;
      const input = await readJsonBody(request, 110 * 1024);
      if (!input || typeof input.command !== 'string')
        throw new CliError('INVALID_ARGUMENT', 'Expected a CLI command.');
      const assertGrant = () => {
        if (lookup(grant.id) !== grant)
          throw new CliError('GRANT_REVOKED', 'This grant has expired or was revoked.', 401);
      };
      assertGrant();
      requestId = input.command === 'submit' ? input.plan : input.requestId;
      const signals = [grant.controller.signal, aborted.signal];
      if (['preview', 'submit', 'reply', 'comment', 'reserve'].includes(input.command)) {
        if (mode !== 'write' || grant.scope !== 'propose')
          throw new CliError('READ_ONLY', 'This CLI grant is read-only.', 403);
        signals.push(grant.writeController.signal);
      }
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      const data = await commands.execute(grant, input, assertGrant, signal);
      assertGrant();
      if (!response.destroyed) json(200, { ok: true, data });
    } catch (error) {
      if (!response.destroyed && !response.headersSent) {
        const failure =
          error instanceof CliError ? error : new CliError('REQUEST_FAILED', 'The CLI request could not be completed.');
        json(failure.status, {
          ok: false,
          error: {
            code: failure.code,
            message: failure.message,
            ...(typeof requestId === 'string' && CLI_UUID.test(requestId) ? { requestId } : {}),
          },
        });
      }
    } finally {
      if (charged) activeRequests--;
      response.off('close', onClose);
    }
    return true;
  }

  return {
    handle,
    clear,
    close() {
      closed = true;
      clear();
    },
  };
}
