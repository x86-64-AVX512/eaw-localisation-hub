import { createHash, createHmac } from 'node:crypto';

export const CLI_ROUTE = '/api/cli/v1/';
export const CLI_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class CliError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function cliDigest(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function cliProof(digest, id, nonce) {
  return createHmac('sha256', Buffer.from(digest, 'hex')).update(`eaw-cli-v1:${id}:${nonce}`).digest('hex');
}

export function parseCliToken(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  const [version, port, id, secret] = parts;
  if (
    parts.length !== 4 ||
    version !== 'eaw1' ||
    !/^[1-9]\d{0,4}$/u.test(port) ||
    Number(port) > 65535 ||
    !CLI_UUID.test(id) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(secret)
  )
    return null;
  return { port: Number(port), id, secret };
}
