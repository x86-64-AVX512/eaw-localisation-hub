import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Windows updater streams progress and verifies Agent restart without installing anything', {
  skip: process.platform !== 'win32', timeout: 45_000,
}, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/error') { res.writeHead(503).end(); return; }
    if (req.url === '/stall') { res.writeHead(200); res.flushHeaders(); return; }
    if (req.url === '/short') { res.end(Buffer.alloc(512, 65)); return; }
    res.writeHead(200, { 'Content-Length': 1024 * 1024 });
    let chunks = 0;
    const timer = setInterval(() => {
      res.write(Buffer.alloc(65536, 65));
      if (++chunks === 16) { clearInterval(timer); res.end(); }
    }, 90);
    res.on('close', () => clearInterval(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts/verify-client-update-progress.ps1'), '-DownloadTestUrl',
    `http://127.0.0.1:${server.address().port}`], { cwd: root, windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const watchdog = setTimeout(() => child.kill(), 40_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /real loopback streaming/);
    assert.match(output, /verified restart/);
  } finally {
    clearTimeout(watchdog);
    child.kill();
    server.closeAllConnections();
    server.close();
  }
});

test('Windows update checks cannot download or install without explicit consent', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts/verify-client-update-consent.ps1')], { cwd: root, windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const watchdog = setTimeout(() => child.kill(), 12_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /check-only entry point/);
  } finally {
    clearTimeout(watchdog);
    child.kill();
  }
});
