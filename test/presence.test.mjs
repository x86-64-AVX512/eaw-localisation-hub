import assert from 'node:assert/strict';
import test from 'node:test';
import { expiredPresenceIds } from '../packages/shared/src/presence.mjs';
import { LocalPresenceMux } from '../apps/agent/src/local-presence.mjs';

test('presence expiry removes only clients whose in-memory heartbeat is stale', () => {
  const lastSeen = new Map([
    ['fresh', 90_000],
    ['boundary', 55_000],
    ['stale', 10_000],
  ]);
  assert.deepEqual(expiredPresenceIds(lastSeen, 100_000, 45_000), ['boundary', 'stale']);
  assert.equal(lastSeen.size, 3, 'the pure expiry check must not retain or mutate personal metadata');
});

test('presence expiry rejects invalid timing configuration', () => {
  assert.throws(() => expiredPresenceIds(new Map(), Date.now(), 0), /finite positive/);
  assert.throws(() => expiredPresenceIds({}, Date.now(), 45_000), /must be a Map/);
});

test('Agent publishes one cursor and gives Review priority over its Legacy plugin', () => {
  const sent = [];
  const binding = {
    synced: true,
    hub: { presenceClientId: 'one-agent-cursor' },
    socket: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) },
  };
  const mux = new LocalPresenceMux(binding);
  const plugin = { clientId: 'plugin-local', kind: 'plugin' };
  const review = { clientId: 'review-local', kind: 'review' };
  const payload = (position) => ({ type: 'presence', position, user: 'Alice', color: '#ff6677' });

  mux.update(plugin, payload(1));
  mux.update(review, payload(2));
  mux.update(plugin, payload(3));
  assert.equal(sent.at(-1).clientId, 'one-agent-cursor');
  assert.equal(sent.at(-1).position, 2, 'Legacy heartbeat must not replace the Review cursor');
  mux.remove(review);
  assert.equal(sent.at(-1).position, 3, 'Legacy cursor resumes after Review closes');
  mux.remove(plugin);
  assert.deepEqual(sent.at(-1), { type: 'presence', clientId: 'one-agent-cursor', offline: true });
});
