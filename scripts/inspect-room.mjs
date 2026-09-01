import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import process from 'node:process';
import { WebSocket } from 'ws';
import * as Y from 'yjs';

function parseArguments(argv) {
  const options = {
    server: 'ws://127.0.0.1:3210',
    document: null,
    expectFile: null,
    showText: false,
    token: process.env.EAW_HUB_TOKEN ?? '',
    tokenFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--server') options.server = argv[++index];
    else if (argument === '--document') options.document = argv[++index];
    else if (argument === '--expect-file') options.expectFile = argv[++index];
    else if (argument === '--show-text') options.showText = true;
    else if (argument === '--token-file') options.tokenFile = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.document) throw new Error('--document is required');
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.tokenFile) options.token = (await fs.readFile(options.tokenFile, 'utf8')).trim();
const document = new Y.Doc();
const url = new URL(options.server);
url.searchParams.set('document', options.document);
const socket = new WebSocket(url, {
  headers: options.token ? { authorization: `Bearer ${options.token}` } : undefined,
});

const synced = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out waiting for room state')), 10000);
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      Y.applyUpdate(document, new Uint8Array(data));
      return;
    }
    const message = JSON.parse(data.toString('utf8'));
    if (message.type === 'synced') {
      clearTimeout(timer);
      resolve(message);
    }
  });
  socket.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

const text = document.getText('content').toString();
if (options.expectFile) {
  const expected = await fs.readFile(options.expectFile, 'utf8');
  if (text !== expected) {
    socket.close();
    throw new Error(`Room text differs from ${options.expectFile}: room=${text.length}, file=${expected.length}`);
  }
}
console.log(JSON.stringify({
  documentId: synced.documentId,
  characters: text.length,
  sha256: crypto.createHash('sha256').update(text).digest('hex'),
  reservations: synced.reservations?.length ?? 0,
  comments: synced.commentThreads?.length ?? 0,
  suggestions: synced.suggestions?.length ?? 0,
}, null, 2));
if (options.showText) process.stdout.write(`\n--- room text ---\n${text}\n--- end room text ---\n`);
socket.close();
document.destroy();
