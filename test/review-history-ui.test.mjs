import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'apps/review/src/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/review/src/app.js'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'apps/review/src/history-panel.js'), 'utf8');

test('Review exposes version comparison and non-destructive restoration', () => {
  assert.match(html, /id="history-open"/u);
  assert.match(html, /id="history-diff"/u);
  assert.match(html, /id="history-restore"/u);
  assert.match(app, /message\.type === 'historyVersion'/u);
  assert.match(panel, /createDiffEditor/u);
  assert.match(panel, /Текущее состояние останется в истории/u);
  assert.match(panel, /type: 'historyRestore'/u);
  assert.match(panel, /toLocaleString\(\)/u);
});
