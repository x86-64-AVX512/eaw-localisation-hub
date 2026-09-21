const encoder = new TextEncoder();
const decoder = new TextDecoder();
const COORDINATE_STEP = 4096;
let coordinateText = null;
let coordinateIndex = null;

function coordinatesFor(text) {
  if (coordinateText === text && coordinateIndex) return coordinateIndex;
  const checkpoints = [{ utf16: 0, bytes: 0 }];
  let utf16 = 0; let bytes = 0;
  while (utf16 < text.length) {
    let next = Math.min(text.length, utf16 + COORDINATE_STEP);
    const previousCode = text.charCodeAt(next - 1);
    const nextCode = text.charCodeAt(next);
    if (next < text.length && previousCode >= 0xd800 && previousCode <= 0xdbff
      && nextCode >= 0xdc00 && nextCode <= 0xdfff) next -= 1;
    bytes += encoder.encode(text.slice(utf16, next)).length;
    utf16 = next;
    checkpoints.push({ utf16, bytes });
  }
  coordinateText = text;
  coordinateIndex = checkpoints;
  return checkpoints;
}

function checkpointFor(checkpoints, position, field) {
  let low = 0; let high = checkpoints.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (checkpoints[middle][field] <= position) low = middle;
    else high = middle - 1;
  }
  return checkpoints[low];
}

export function decodeBase64(value) {
  const binary = atob(value || '');
  return decoder.decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function encodeBase64(value) {
  const bytes = encoder.encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function utf16ToByte(text, index) {
  if (index < 0 || index > text.length) return encoder.encode(text.slice(0, index)).length;
  const checkpoint = checkpointFor(coordinatesFor(text), index, 'utf16');
  return checkpoint.bytes + encoder.encode(text.slice(checkpoint.utf16, index)).length;
}

export function byteToUtf16(text, byteOffset) {
  const checkpoints = coordinatesFor(text);
  if (byteOffset < 0 || byteOffset > checkpoints.at(-1).bytes) throw new RangeError('Invalid UTF-8 byte position');
  const checkpoint = checkpointFor(checkpoints, byteOffset, 'bytes');
  if (checkpoint.bytes === byteOffset) return checkpoint.utf16;
  const bytes = encoder.encode(text.slice(checkpoint.utf16, checkpoint.utf16 + COORDINATE_STEP + 1));
  return checkpoint.utf16 + decoder.decode(bytes.subarray(0, byteOffset - checkpoint.bytes)).length;
}

export function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#6aa9ff';
}

const colorClasses = new Map();
export function colorClass(prefix, color, rule) {
  color = safeColor(color);
  const key = `${prefix}-${color.slice(1).toLowerCase()}`;
  if (!colorClasses.has(key)) {
    const style = document.createElement('style');
    style.textContent = `.${key}{${rule(color)}}`;
    document.head.append(style);
    colorClasses.set(key, true);
  }
  return key;
}

export function createDialogController() {
  const dialog = document.querySelector('#text-dialog');
  const title = document.querySelector('#dialog-title');
  const label = document.querySelector('#dialog-label');
  const value = document.querySelector('#dialog-value');
  return async (heading, description, initial = '') => {
    title.textContent = heading;
    label.textContent = description;
    value.value = initial;
    dialog.showModal();
    value.focus();
    value.select();
    return new Promise((resolve) => dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'default' ? value.value : null);
    }, { once: true }));
  };
}
