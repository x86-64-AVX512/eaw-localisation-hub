import crypto from 'node:crypto';

interface ScryptParameters {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

export function scryptAsync(password: string, salt: Uint8Array, keyLength: number,
  options: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
