import test from 'node:test';
import assert from 'node:assert/strict';
import { serverHttpUrl } from '../apps/agent/src/server-http-url.mjs';

test('Agent keeps ticket query parameters separate from the request pathname', () => {
  const endpoint = serverHttpUrl(
    'wss://eawhub.mooo.com:10443',
    '/api/tickets?archived=1',
  );
  assert.equal(endpoint.href, 'https://eawhub.mooo.com:10443/api/tickets?archived=1');
  assert.equal(endpoint.pathname, '/api/tickets');
  assert.equal(endpoint.search, '?archived=1');
});

test('Agent HTTP routes cannot redirect credentials to another origin', () => {
  assert.throws(() => serverHttpUrl('wss://eawhub.mooo.com:10443', 'https://example.com/steal'));
  assert.throws(() => serverHttpUrl('wss://eawhub.mooo.com:10443', '//example.com/steal'));
  assert.throws(() => serverHttpUrl('https://eawhub.mooo.com:10443', '/api/tickets'));
});
