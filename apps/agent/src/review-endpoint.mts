import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const OWNER_PROBE_PATH = '/api/review-endpoint-owner';

export interface ReviewEndpoint {
  schema: 1;
  port: number;
  token: string;
}

type StoredEndpoint = ReviewEndpoint & { endpointPath: string };

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function validEndpoint(value: unknown): value is ReviewEndpoint {
  return (
    value !== null &&
    typeof value === 'object' &&
    'schema' in value &&
    'port' in value &&
    'token' in value &&
    value.schema === 1 &&
    typeof value.port === 'number' &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535 &&
    typeof value.token === 'string' &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.token)
  );
}

export async function loadReviewEndpoint(options: { state: string }): Promise<StoredEndpoint> {
  const endpointPath = path.join(options.state, 'review-endpoint.json');
  try {
    const existing: unknown = JSON.parse(await fs.readFile(endpointPath, 'utf8'));
    if (validEndpoint(existing)) return { ...existing, endpointPath };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  return {
    schema: 1,
    port: 0,
    token: crypto.randomBytes(32).toString('base64url'),
    endpointPath,
  };
}

async function saveReviewEndpoint({ endpointPath, ...endpoint }: StoredEndpoint): Promise<void> {
  await fs.mkdir(path.dirname(endpointPath), { recursive: true });
  const temporary = `${endpointPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, endpointPath);
    await fs.chmod(endpointPath, 0o600).catch(() => {});
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function listenLoopback(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    function cleanup() {
      server.off('listening', listening);
      server.off('error', failed);
    }
    function failed(error: unknown) {
      cleanup();
      reject(error);
    }
    function listening() {
      cleanup();
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('Review server did not bind a TCP port'));
    }
    server.once('listening', listening);
    server.once('error', failed);
    try {
      server.listen(port, '127.0.0.1');
    } catch (error) {
      failed(error);
    }
  });
}

function ownerProof(token: string, nonce: string): string {
  return crypto.createHmac('sha256', token).update(`eaw-review-owner:${nonce}`).digest('hex');
}

export function respondToReviewOwnerProbe(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  token: string,
): boolean {
  if (request.method !== 'HEAD' || url.pathname !== OWNER_PROBE_PATH) return false;
  const nonce = url.searchParams.get('nonce') ?? '';
  if (!/^[0-9a-f]{32}$/u.test(nonce)) {
    response.writeHead(400).end();
  } else {
    response.writeHead(204, { 'Cache-Control': 'no-store', 'X-EaW-Review-Owner': ownerProof(token, nonce) }).end();
  }
  return true;
}

async function runningReviewOwnsPort(endpoint: StoredEndpoint): Promise<boolean> {
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    // The listener proves it owns our endpoint without receiving its bearer token.
    const response = await fetch(`http://127.0.0.1:${endpoint.port}${OWNER_PROBE_PATH}?nonce=${nonce}`, {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(750),
    });
    return response.status === 204 && response.headers.get('X-EaW-Review-Owner') === ownerProof(endpoint.token, nonce);
  } catch {
    return false;
  }
}

export async function listenReviewEndpoint(server: Server, endpoint: StoredEndpoint): Promise<void> {
  const previousPort = endpoint.port;
  let failureCode;
  if (previousPort) {
    try {
      await listenLoopback(server, previousPort);
      return;
    } catch (error) {
      failureCode = errorCode(error);
      if (failureCode !== 'EADDRINUSE' && failureCode !== 'EACCES') throw error;
      if (failureCode === 'EADDRINUSE' && (await runningReviewOwnsPort(endpoint))) {
        throw new Error('Desktop Agent is already running for this Review state directory', { cause: error });
      }
      // An open Review can still attempt to reconnect to the old origin.
      endpoint.token = crypto.randomBytes(32).toString('base64url');
    }
  }
  endpoint.port = await listenLoopback(server, 0);
  await saveReviewEndpoint(endpoint);
  if (previousPort) {
    console.warn(
      `[agent] Review moved from port ${previousPort} to ${endpoint.port} (${failureCode}). Drafts and settings in browser storage remain associated with the old address.`,
    );
  }
}
