import fs from 'node:fs/promises';
import http from 'node:http';

const readyFile = process.argv[2];
if (!readyFile) throw new Error('Expected a ready-file path');

const server = http.createServer((request, response) => {
  if (request.url !== '/api/admin/backup') {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization === 'Bearer eaw_backup_plain_error') {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('Backup upstream unavailable');
    return;
  }
  if (request.headers.authorization !== 'Bearer eaw_backup_test') {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Backup token required' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream' });
  response.end(Buffer.from('offline backup fixture', 'utf8'));
});

server.listen(0, '127.0.0.1', async () => {
  try {
    await fs.writeFile(readyFile, String(server.address().port));
  } catch (error) {
    server.close();
    throw error;
  }
});
