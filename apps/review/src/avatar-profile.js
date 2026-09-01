const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_AVATAR_BYTES = 16 * 1024;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1] ?? ''));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

async function canvasBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
}

export async function prepareAvatar(file) {
  if (!file || file.size > MAX_INPUT_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Выберите PNG, JPEG или WebP размером не более 10 МиБ.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const size = 96;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { alpha: false });
    const sourceSize = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap,
      (bitmap.width - sourceSize) / 2, (bitmap.height - sourceSize) / 2, sourceSize, sourceSize,
      0, 0, size, size);
    for (const quality of [0.82, 0.68, 0.52]) {
      const blob = await canvasBlob(canvas, quality);
      if (blob && blob.size <= MAX_AVATAR_BYTES) return blobToBase64(blob);
    }
    throw new Error('Изображение не удалось уложить в безопасный лимит 16 КиБ.');
  } finally {
    bitmap.close();
  }
}

export function createAvatarProfile({ state, send, showToast }) {
  const input = document.querySelector('#avatar-file');
  const change = document.querySelector('#avatar-change');
  const remove = document.querySelector('#avatar-delete');
  change.addEventListener('click', () => input.click());
  remove.addEventListener('click', () => send({ type: 'avatarDelete', path: state.path }));
  input.addEventListener('change', async () => {
    const [file] = input.files;
    input.value = '';
    if (!file) return;
    change.disabled = true;
    try {
      const avatarBase64 = await prepareAvatar(file);
      send({ type: 'avatarSet', path: state.path, avatarBase64 });
    } catch (error) {
      showToast(error.message, true);
    } finally {
      change.disabled = false;
    }
  });
  return {
    refresh() { remove.disabled = !state.avatarBase64; },
  };
}
