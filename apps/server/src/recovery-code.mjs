import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PREFIX = 'EAWH-R1';
const SECRET_BYTES = 32;

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

function checksum(payload) {
  return base32(crypto.createHash('sha256').update(payload, 'ascii').digest()).slice(0, 4);
}

export function generateRecoveryCode() {
  const payload = base32(crypto.randomBytes(SECRET_BYTES));
  return `${PREFIX}-${[...payload, ...checksum(payload)].reduce((groups, character, index) => {
    const group = Math.floor(index / 4);
    groups[group] = `${groups[group] ?? ''}${character}`;
    return groups;
  }, []).join('-')}`;
}

export function normaliseRecoveryCode(value) {
  const compact = String(value ?? '').trim().toUpperCase().replaceAll('-', '');
  const compactPrefix = PREFIX.replaceAll('-', '');
  if (!compact.startsWith(compactPrefix)) return '';
  const encoded = compact.slice(compactPrefix.length);
  if (encoded.length !== 56 || !/^[A-Z2-7]+$/u.test(encoded)) return '';
  const payload = encoded.slice(0, -4);
  const actualChecksum = encoded.slice(-4);
  const expectedChecksum = checksum(payload);
  const actual = Buffer.from(actualChecksum, 'ascii');
  const expected = Buffer.from(expectedChecksum, 'ascii');
  if (!crypto.timingSafeEqual(actual, expected)) return '';
  return `${PREFIX}-${encoded.match(/.{1,4}/gu).join('-')}`;
}

export class RecoveryCodeHasher {
  constructor(dataDirectory, atomicWrite) {
    this.path = path.join(dataDirectory, 'recovery-pepper.key');
    this.atomicWrite = atomicWrite;
    this.key = null;
  }

  async initialise() {
    try {
      const encoded = (await fs.readFile(this.path, 'utf8')).trim();
      const key = Buffer.from(encoded, 'base64url');
      if (key.length !== 32) throw new Error('Recovery-code pepper is invalid');
      this.key = key;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.key = crypto.randomBytes(32);
      await this.atomicWrite(this.path, `${this.key.toString('base64url')}\n`);
      await fs.chmod(this.path, 0o600).catch(() => {});
    }
  }

  hash(code) {
    if (!this.key) throw new Error('Recovery-code hasher is not initialised');
    const normalised = normaliseRecoveryCode(code);
    if (!normalised) return '';
    return crypto.createHmac('sha256', this.key).update(normalised, 'ascii').digest('hex');
  }

  matches(code, expectedHash) {
    const actualHash = this.hash(code);
    if (!actualHash || !/^[0-9a-f]{64}$/u.test(String(expectedHash))) return false;
    return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
  }
}
