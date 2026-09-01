import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
const MAGIC = Buffer.from('EAWHUBENC1\0', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function isEncryptedBackup(data) {
  const buffer = Buffer.from(data);
  return buffer.length >= MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

async function deriveKey(passphrase, salt) {
  const value = String(passphrase ?? '');
  if (value.length < 12) throw new Error('Backup passphrase must contain at least 12 characters');
  return scryptAsync(value, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export async function encryptBackup(data, passphrase) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

export async function decryptBackup(data, passphrase) {
  const buffer = Buffer.from(data);
  if (!isEncryptedBackup(buffer)) return buffer;
  const headerBytes = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (buffer.length <= headerBytes) throw new Error('Encrypted backup is truncated');
  let offset = MAGIC.length;
  const salt = buffer.subarray(offset, offset += SALT_BYTES);
  const iv = buffer.subarray(offset, offset += IV_BYTES);
  const tag = buffer.subarray(offset, offset += TAG_BYTES);
  const ciphertext = buffer.subarray(offset);
  const key = await deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Backup passphrase is incorrect or the backup is damaged');
  }
}
