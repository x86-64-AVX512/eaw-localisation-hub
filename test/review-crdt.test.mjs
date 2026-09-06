import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { createReviewDocument } from '../apps/review/src/review-document.js';
import { applyReviewUpdate, broadcastReviewUpdate, resolveReviewAnchors } from '../apps/agent/src/review-document.mjs';

const encode = (update) => Buffer.from(update).toString('base64');
const documentId = 'workspace/file';
const absolutePath = 'C:/repo/localisation/russian/file.yml';

test('queued Monaco events use ordered changes even when the model exposes future typing', () => {
  const agent = new Y.Doc(); agent.getText('content').insert(0, 'abc');
  const browser = peer(agent);
  const finalText = 'abc F2🦄';
  let offset = 3;
  for (const text of [' ', 'F', '2', '🦄']) {
    browser.review.commit(finalText, [{ rangeOffset: offset, rangeLength: 0, text }]);
    offset += text.length;
  }
  for (const message of browser.sent) Y.applyUpdate(agent, Buffer.from(message.updateBase64, 'base64'));
  assert.equal(browser.review.text(), finalText);
  assert.equal(agent.getText('content').toString(), finalText);
  browser.review.dispose(); agent.destroy();
});

function peer(document) {
  const sent = [];
  let visible = '';
  const review = createReviewDocument({ send: (message) => sent.push(message), onText: (text) => { visible = text; } });
  review.receive({ documentId, path: absolutePath, updateBase64: encode(Y.encodeStateAsUpdate(document)) });
  return { review, sent, get visible() { return visible; } };
}

test('Review merges a remote replacement while a local insertion is still in flight', () => {
  const agent = new Y.Doc();
  agent.getText('content').insert(0, 'abc');
  const browser = peer(agent);
  browser.review.commit('Xabc', [{ rangeOffset: 0, rangeLength: 0, text: 'X' }]);
  assert.equal(browser.sent.length, 1, 'typing is sent immediately, without a snapshot debounce');
  const before = Y.encodeStateVector(agent);
  agent.transact(() => { agent.getText('content').delete(1, 1); agent.getText('content').insert(1, 'B'); });
  browser.review.receive({ documentId, path: absolutePath, updateBase64: encode(Y.encodeStateAsUpdate(agent, before)) });
  assert.equal(browser.visible, 'XaBc');
  const client = { kind: 'review', reviewCrdt: true };
  const state = { initialised: true, origin: {} };
  const binding = { document: agent, text: agent.getText('content'), documentId, gitWritable: true, requireState: () => state };
  assert.equal(applyReviewUpdate(binding, client, absolutePath, browser.sent[0]), true);
  assert.equal(agent.getText('content').toString(), 'XaBc');
  browser.review.dispose(); agent.destroy();
});

test('multi-cursor edits preserve a concurrent edit between the changed ranges', () => {
  const agent = new Y.Doc(); agent.getText('content').insert(0, 'a中🦄z');
  const browser = peer(agent);
  browser.review.commit('A中🦄Z', [
    { rangeOffset: 0, rangeLength: 1, text: 'A' },
    { rangeOffset: 4, rangeLength: 1, text: 'Z' },
  ]);
  agent.transact(() => { agent.getText('content').delete(1, 1); agent.getText('content').insert(1, '文'); });
  Y.applyUpdate(agent, Buffer.from(browser.sent[0].updateBase64, 'base64'));
  browser.review.receive({ documentId, path: absolutePath, updateBase64: encode(Y.encodeStateAsUpdate(agent)) });
  assert.equal(browser.review.text(), 'A文🦄Z');
  assert.equal(agent.getText('content').toString(), 'A文🦄Z');
  browser.review.dispose(); agent.destroy();
});

test('Review replays an unacknowledged edit after reconnect without duplicating it', () => {
  const agent = new Y.Doc(); agent.getText('content').insert(0, 'base');
  const browser = peer(agent);
  browser.review.commit('base!');
  browser.sent.length = 0; // Simulate losing the browser-to-Agent frame.
  browser.review.receive({ documentId, path: absolutePath, updateBase64: encode(Y.encodeStateAsUpdate(agent)) });
  assert.equal(browser.review.text(), 'base!');
  browser.review.replay();
  const update = Buffer.from(browser.sent[0].updateBase64, 'base64');
  Y.applyUpdate(agent, update); Y.applyUpdate(agent, update);
  assert.equal(agent.getText('content').toString(), 'base!');
  browser.review.dispose(); agent.destroy();
});

test('Agent rejects a Review CRDT update for a different document or a Legacy client', () => {
  const document = new Y.Doc();
  const state = { initialised: true, origin: {} };
  const binding = { document, text: document.getText('content'), documentId, gitWritable: true, requireState: () => state };
  const message = { documentId: 'another-branch/file', updateBase64: encode(Y.encodeStateAsUpdate(document)) };
  assert.equal(applyReviewUpdate(binding, { kind: 'review', reviewCrdt: true }, absolutePath, message), false);
  assert.equal(applyReviewUpdate(binding, { kind: 'plugin' }, absolutePath, { ...message, documentId }), false);
  document.destroy();
});

test('Agent broadcasts CRDT deltas to other ready Review peers, without echoing local edits', () => {
  const origin = {};
  const binding = { documentId, clients: new Set() };
  const sender = { kind: 'review', reviewCrdt: true, sent: [], documents: new Map(), send(message) { this.sent.push(message); } };
  const observer = { ...sender, sent: [], documents: new Map() };
  sender.documents.set(absolutePath, { binding, reviewSynced: true, origin });
  observer.documents.set(absolutePath, { binding, reviewSynced: true, origin: {} });
  binding.clients.add(sender); binding.clients.add(observer);
  broadcastReviewUpdate(binding, Uint8Array.of(0, 0), origin);
  assert.equal(sender.sent.length, 0);
  assert.equal(observer.sent[0].type, 'documentSync');
});

test('Review suggestion ranges follow their characters while another edit is in flight', () => {
  const document = new Y.Doc(); document.getText('content').insert(0, 'a word z');
  const browser = peer(document);
  const message = browser.review.anchor({ type: 'suggestionCreate', startByte: 2, endByte: 6 });
  document.getText('content').insert(0, 'new ');
  const binding = { document, documentId, text: document.getText('content') };
  const client = { kind: 'review', reviewCrdt: true };
  const resolved = resolveReviewAnchors(binding, client, message);
  assert.equal(resolved.startByte, 6); assert.equal(resolved.endByte, 10);
  document.getText('content').delete(6, 1);
  assert.equal(resolveReviewAnchors(binding, client, message), null, 'changed source text must not silently become a new suggestion target');
  browser.review.dispose(); document.destroy();
});
