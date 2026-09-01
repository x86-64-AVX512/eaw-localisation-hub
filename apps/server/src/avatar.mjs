const MAX_AVATAR_BYTES = 16 * 1024;

export function normaliseAvatarBase64(value, { optional = false } = {}) {
  const encoded = String(value ?? '');
  if (!encoded && optional) return '';
  if (!encoded || encoded.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 4
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new TypeError('Avatar must be a bounded base64 WebP image');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 30 || bytes.length > MAX_AVATAR_BYTES
      || bytes.toString('ascii', 0, 4) !== 'RIFF'
      || bytes.toString('ascii', 8, 12) !== 'WEBP'
      || bytes.readUInt32LE(4) + 8 !== bytes.length
      || bytes.toString('base64') !== encoded) {
    throw new TypeError('Avatar must be a valid canonical WebP image no larger than 16 KiB');
  }
  const kind = bytes.toString('ascii', 12, 16);
  const chunkBytes = bytes.readUInt32LE(16);
  if (!['VP8 ', 'VP8L', 'VP8X'].includes(kind) || 20 + chunkBytes + (chunkBytes % 2) > bytes.length) {
    throw new TypeError('Avatar contains an invalid WebP image chunk');
  }
  let width;
  let height;
  if (kind === 'VP8 ') {
    if (chunkBytes < 10 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new TypeError('Avatar contains an invalid lossy WebP frame');
    }
    width = bytes.readUInt16LE(26) & 0x3fff;
    height = bytes.readUInt16LE(28) & 0x3fff;
  } else if (kind === 'VP8L') {
    if (chunkBytes < 5 || bytes[20] !== 0x2f) throw new TypeError('Avatar contains an invalid lossless WebP frame');
    width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
    height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
  } else {
    if (chunkBytes < 10) throw new TypeError('Avatar contains an invalid extended WebP frame');
    width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
  }
  if (width < 16 || height < 16 || width > 256 || height > 256) {
    throw new TypeError('Avatar dimensions must be between 16 and 256 pixels');
  }
  return encoded;
}

export { MAX_AVATAR_BYTES };
