const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
  return encoder.encode(text.slice(0, index)).length;
}

export function byteToUtf16(text, byteOffset) {
  const bytes = encoder.encode(text);
  if (byteOffset < 0 || byteOffset > bytes.length) throw new RangeError('Invalid UTF-8 byte position');
  return decoder.decode(bytes.slice(0, byteOffset)).length;
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
