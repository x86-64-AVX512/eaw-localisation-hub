import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CLI_ROUTE, CLI_UUID, CliError, cliDigest, cliProof, parseCliToken } from './cli-protocol.mjs';

const usage = `Usage: eaw-hub <command> [options] [--json]

  status
  search --key KEY [--lang ru|en] [--offset N] [--limit N]
  read --file FILE [--key KEY] [--ticket ID]
  ticket list [--offset N] [--limit N]
  ticket read --id ID
  history list --file FILE [--ticket ID] [--offset N] [--limit N]
  history read --file FILE --id VERSION_ID [--ticket ID]
  discussion list --file FILE [--key KEY] [--id ID] [--ticket ID] [--offset N] [--limit N]
  discussion create --file FILE --key KEY --revision SHA256 --text-stdin [--ticket ID] [--request-id ID]
  discussion reply --file FILE --kind comment|suggestion --id ID --text-stdin [--ticket ID] [--request-id ID]
  suggestion preview --file FILE --key KEY --text-stdin [--ticket ID]
  suggestion submit --plan ID
  reservation list --file FILE [--key KEY] [--ticket ID] [--offset N] [--limit N]
  reservation create --file FILE --key KEY --revision SHA256 [--text-stdin] [--ticket ID] [--request-id ID]

Obtain a grant in Desktop Agent → CLI access. Supply it via EAW_HUB_CLI_TOKEN
or --token-file PATH. Text can also be read via --text-file PATH.
`;

/** @type {import('node:util').ParseArgsOptionsConfig} */
const flags = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  key: { type: 'string' },
  lang: { type: 'string' },
  file: { type: 'string' },
  ticket: { type: 'string' },
  plan: { type: 'string' },
  revision: { type: 'string' },
  kind: { type: 'string' },
  id: { type: 'string' },
  'request-id': { type: 'string' },
  offset: { type: 'string' },
  limit: { type: 'string' },
  'token-file': { type: 'string' },
  'text-stdin': { type: 'boolean' },
  'text-file': { type: 'string' },
};

const commands = {
  status: ['status', '', ''],
  search: ['search', 'key', 'lang offset limit'],
  read: ['read', 'file', 'key ticket'],
  'ticket list': ['tickets', '', 'offset limit'],
  'ticket read': ['ticket', 'id', ''],
  'history list': ['history', 'file', 'ticket offset limit'],
  'history read': ['history-read', 'file id', 'ticket'],
  'discussion list': ['discussions', 'file', 'key id ticket offset limit'],
  'discussion create': ['comment', 'file key revision', 'ticket request-id'],
  'discussion reply': ['reply', 'file kind id', 'ticket request-id'],
  'suggestion preview': ['preview', 'file key', 'ticket'],
  'suggestion submit': ['submit', 'plan', ''],
  'reservation list': ['reservations', 'file', 'key ticket offset limit'],
  'reservation create': ['reserve', 'file key revision', 'ticket request-id'],
};

async function readText(source, maximum, { trimLineEnding = false, option = 'text-file' } = {}) {
  const oversized = () => new CliError('INVALID_ARGUMENT', `Input exceeds ${maximum} bytes.`);
  let handle;
  try {
    handle = source ? await fs.open(source, 'r') : null;
    const chunks = [];
    let size = 0;
    for await (const chunk of handle ? handle.createReadStream({ autoClose: false }) : process.stdin) {
      size += chunk.length;
      if (size > maximum + (trimLineEnding ? 2 : 0)) throw oversized();
      chunks.push(chunk);
    }
    let bytes = Buffer.concat(chunks);
    if (trimLineEnding && bytes.at(-1) === 10) {
      bytes = bytes.subarray(0, bytes.at(-2) === 13 ? -2 : -1);
    }
    if (bytes.length > maximum) throw oversized();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new CliError('INVALID_ARGUMENT', 'Input must be valid UTF-8.');
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('INVALID_ARGUMENT', source ? `Could not read --${option}.` : 'Could not read standard input.');
  } finally {
    await handle?.close();
  }
}

function numberOption(value) {
  if (!/^\d+$/u.test(value)) throw new CliError('INVALID_ARGUMENT', 'Offset and limit must be integers.');
  return Number(value);
}

async function run(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, options: flags, allowPositionals: true });
  } catch (error) {
    throw new CliError('INVALID_ARGUMENT', error.message);
  }
  const values = args.values;
  if (values.help || (!argv.length && !args.positionals.length)) return { help: usage };
  const spec = Object.hasOwn(commands, args.positionals.join(' ')) ? commands[args.positionals.join(' ')] : null;
  if (!spec) throw new CliError('UNKNOWN_COMMAND', 'Unknown command. See eaw-hub --help.');
  const [command, required, optional] = spec;
  const textInput = ['comment', 'reply', 'preview'].includes(command);
  const supported = ['json', 'token-file', ...required.split(' '), ...optional.split(' ')];
  if (textInput || command === 'reserve') supported.push('text-stdin', 'text-file');
  for (const option of Object.keys(values)) {
    if (!supported.includes(option)) throw new CliError('INVALID_ARGUMENT', `Unexpected --${option}.`);
  }
  const input = { command };
  for (const key of required.split(' ').filter(Boolean)) {
    if (!values[key]) throw new CliError('INVALID_ARGUMENT', `Missing --${key}.`);
  }
  for (const key of `${required} ${optional}`.split(' ').filter(Boolean)) {
    if (values[key] !== undefined)
      input[key === 'request-id' ? 'requestId' : key] = ['offset', 'limit'].includes(key)
        ? numberOption(values[key])
        : values[key];
  }
  if (textInput || values['text-stdin'] || values['text-file']) {
    if (Boolean(values['text-stdin']) === Boolean(values['text-file'])) {
      throw new CliError('INVALID_ARGUMENT', 'Choose exactly one of --text-stdin and --text-file.');
    }
    const maximum = command === 'preview' ? 16 * 1024 : command === 'reserve' ? 1024 : 2048;
    input.text = await readText(values['text-file'], maximum, {
      trimLineEnding: ['preview', 'reserve'].includes(command),
    });
  }
  if (['comment', 'reply', 'reserve'].includes(command)) input.requestId ??= randomUUID();
  const requestId = input.requestId ?? input.plan;
  if (requestId && !CLI_UUID.test(requestId)) throw new CliError('INVALID_ARGUMENT', 'Expected a lowercase UUID.');
  const token = String(
    values['token-file']
      ? await readText(values['token-file'], 1024, { option: 'token-file' })
      : (process.env.EAW_HUB_CLI_TOKEN ?? ''),
  ).trim();
  const grant = parseCliToken(token);
  if (!grant) throw new CliError('GRANT_REQUIRED', 'Obtain a CLI grant from Desktop Agent.', 401);
  const base = `http://127.0.0.1:${grant.port}${CLI_ROUTE}`;
  const nonce = randomBytes(16).toString('hex');
  let proof;
  try {
    proof = await fetch(`${base}owner?${new URLSearchParams({ id: grant.id, nonce })}`, {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new CliError('AGENT_UNAVAILABLE', 'Desktop Agent is unavailable.', 503);
  }
  if (proof.status === 403) throw new CliError('CLI_DISABLED', 'Enable CLI access in Desktop Agent.', 403);
  if (
    proof.status !== 204 ||
    proof.headers.get('X-EaW-CLI-Owner') !== cliProof(cliDigest(grant.secret), grant.id, nonce)
  ) {
    throw new CliError('GRANT_REQUIRED', 'The CLI grant is expired, revoked or belongs to another Agent.', 401);
  }
  let result;
  try {
    const response = await fetch(`${base}command`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(40_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    result = await response.json();
  } catch {
    throw new CliError(
      requestId ? 'OUTCOME_UNKNOWN' : 'AGENT_UNAVAILABLE',
      requestId
        ? 'Write not confirmed. Retry the same command with the same ID.'
        : 'Desktop Agent did not complete the request.',
      503,
      requestId ? { requestId } : undefined,
    );
  }
  return result;
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
let result;
try {
  result = await run(argv);
  if (result.help) {
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, data: { help: result.help } })}\n`);
    else process.stdout.write(result.help);
  } else if (result.ok === false && !json)
    process.stderr.write(
      `${result.error.code}: ${result.error.message}${result.error.requestId ? ` (${result.error.requestId})` : ''}\n`,
    );
  else process.stdout.write(`${JSON.stringify(result, null, json ? undefined : 2)}\n`);
} catch (error) {
  const reply = {
    code: error.code ?? 'REQUEST_FAILED',
    message: error instanceof CliError ? error.message : 'The CLI could not complete the request.',
    ...error.details,
  };
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: reply })}\n`);
  else process.stderr.write(`${reply.code}: ${reply.message}${reply.requestId ? ` (${reply.requestId})` : ''}\n`);
  process.exitCode = 1;
}
if (result?.ok === false) process.exitCode = 1;
