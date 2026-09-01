import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MINIMUM_PORT = 49_152;
const PORT_SPAN = 16_000;

function validEndpoint(value) {
  return value?.schema === 1
    && Number.isInteger(value.port) && value.port >= MINIMUM_PORT && value.port < MINIMUM_PORT + PORT_SPAN
    && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value.token);
}

export async function persistentReviewEndpoint(options) {
  const endpointPath = path.join(options.state, 'review-endpoint.json');
  try {
    const existing = JSON.parse(await fs.readFile(endpointPath, 'utf8'));
    if (validEndpoint(existing)) return { ...existing, endpointPath };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const endpoint = {
    schema: 1,
    port: MINIMUM_PORT + crypto.randomInt(PORT_SPAN),
    token: crypto.randomBytes(32).toString('base64url'),
  };
  await fs.mkdir(path.dirname(endpointPath), { recursive: true });
  const temporary = `${endpointPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(endpoint)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(temporary, 0o600).catch(() => {});
  await fs.rename(temporary, endpointPath);
  await fs.chmod(endpointPath, 0o600).catch(() => {});
  return { ...endpoint, endpointPath };
}
