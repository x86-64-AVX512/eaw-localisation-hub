import { safeColor } from './review-utilities.js';

export function avatarElement(name, color, avatarBase64 = '', className = '') {
  const avatar = document.createElement('span');
  avatar.className = `avatar ${className}`.trim();
  avatar.style.setProperty('--avatar-color', safeColor(color));
  const displayName = String(name ?? '?').replace(/\s*\([^)]*\)\s*$/u, '').trim();
  const initials = displayName.split(/\s+/u).slice(0, 2)
    .map((part) => [...part][0] ?? '').join('').toUpperCase() || '?';
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(avatarBase64) && avatarBase64.length <= 24 * 1024) {
    const image = document.createElement('img');
    image.src = `data:image/webp;base64,${avatarBase64}`;
    image.alt = '';
    avatar.append(image);
  } else {
    avatar.textContent = initials;
  }
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}
