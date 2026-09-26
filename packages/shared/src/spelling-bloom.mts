export const SPELLING_BLOOM_BYTES = 8 * 1024 * 1024;
const HASH_COUNT = 7;

function hashPair(value: unknown): [number, number] {
  const word = String(value).toLocaleLowerCase('ru');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < word.length; index += 1) {
    const code = word.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return [first >>> 0, (second | 1) >>> 0];
}

function bitIndexes(bits: Uint8Array, word: unknown): number[] {
  const bitCount = bits.length * 8;
  if (bitCount < 8 || (bitCount & (bitCount - 1)) !== 0) throw new Error('Spelling Bloom size must be a power of two');
  const mask = bitCount - 1;
  const [first, second] = hashPair(word);
  return Array.from({ length: HASH_COUNT }, (_, index) => (
    (first + Math.imul(index, second)) >>> 0
  ) & mask);
}

export function addSpellingBloom(bits: Uint8Array, word: unknown): void {
  for (const bit of bitIndexes(bits, word)) bits[bit >>> 3] |= 1 << (bit & 7);
}

export function hasSpellingBloom(bits: Uint8Array, word: unknown): boolean {
  return bitIndexes(bits, word).every((bit) => (bits[bit >>> 3] & (1 << (bit & 7))) !== 0);
}
