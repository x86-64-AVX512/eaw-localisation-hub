import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseAvatarBase64 } from '../apps/server/src/avatar.mjs';

function extendedWebp(width = 96, height = 96) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes.toString('base64');
}

test('avatar validation accepts bounded WebP and rejects disguised or oversized dimensions', () => {
  const avatar = extendedWebp();
  assert.equal(normaliseAvatarBase64(avatar), avatar);
  assert.equal(normaliseAvatarBase64('', { optional: true }), '');
  assert.throws(() => normaliseAvatarBase64(Buffer.from('not an image').toString('base64')), /WebP/u);
  assert.throws(() => normaliseAvatarBase64(extendedWebp(512, 96)), /dimensions/u);
});
