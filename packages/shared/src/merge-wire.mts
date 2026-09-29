import { Buffer } from 'node:buffer';
import { gzipSync, gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { MAX_ROOM_STATE_BYTES } from './constants.mts';
import { applyUtf8ByteEdit, computeSingleReplace } from './text.mts';

export interface MergeTextPatch {
  positionByte: number;
  deleteBytes: number;
  insertBase64: string;
  encoding: 'utf8' | 'gzip';
}

// All patches in a request/result refer to the same hash-checked shared snapshot.
// Compress only the inserted span, with bounded decompression on the receiver.
export function encodeMergeText(reference: string, text: string): MergeTextPatch {
  if (Buffer.byteLength(text, 'utf8') > MAX_ROOM_STATE_BYTES) {
    throw Object.assign(new RangeError('Текст файла превышает лимит документа для проверки слияния.'), { code: 'EAW_MERGE_LIMIT' });
  }
  const edit = computeSingleReplace(reference, text);
  const bytes = Buffer.from(edit?.insertText ?? '', 'utf8');
  const compressed = bytes.length > 1024 ? gzipSync(bytes) : bytes;
  const gzip = compressed.length < bytes.length;
  return { positionByte: edit?.positionByte ?? 0, deleteBytes: edit?.deleteBytes ?? 0,
    insertBase64: (gzip ? compressed : bytes).toString('base64'), encoding: gzip ? 'gzip' : 'utf8' };
}

export function decodeMergeText(reference: string, value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid merge patch');
  const patch = value as MergeTextPatch;
  if (!Number.isSafeInteger(patch.positionByte) || patch.positionByte < 0
    || !Number.isSafeInteger(patch.deleteBytes) || patch.deleteBytes < 0
    || !['utf8', 'gzip'].includes(patch.encoding)
    || typeof patch.insertBase64 !== 'string' || patch.insertBase64.length > 16 * 1024 * 1024
    || patch.insertBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(patch.insertBase64)) {
    throw new TypeError('Invalid merge patch fields');
  }
  const packed = Buffer.from(patch.insertBase64, 'base64');
  if (packed.toString('base64') !== patch.insertBase64) throw new TypeError('Invalid merge patch base64');
  const bytes = patch.encoding === 'gzip' ? gunzipSync(packed, { maxOutputLength: MAX_ROOM_STATE_BYTES }) : packed;
  if (bytes.length > MAX_ROOM_STATE_BYTES) throw new RangeError('Merge insertion exceeds document limit');
  const inserted = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const result = applyUtf8ByteEdit(reference, patch.positionByte, patch.deleteBytes, inserted);
  if (Buffer.byteLength(result, 'utf8') > MAX_ROOM_STATE_BYTES) throw new RangeError('Merge text exceeds document limit');
  return result;
}
