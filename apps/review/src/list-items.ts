import { safeColor } from './review-utilities.ts';
import { avatarElement } from './avatar-view.ts';

// Shared rows for the presence, reservation and conflict lists in the side panel.
export function listButton(title: string, subtitle: string, color: unknown, selected: boolean,
  action: () => void, avatarBase64 = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `list-item${selected ? ' selected' : ''}`;
  button.style.setProperty('--item-color', safeColor(color));
  const heading = document.createElement('span');
  heading.className = 'item-title';
  const avatar = avatarElement(title, color, avatarBase64, 'avatar-small');
  const text = document.createElement('span');
  text.textContent = title;
  heading.append(avatar, text);
  button.append(heading);
  if (subtitle) {
    const detail = document.createElement('small');
    detail.textContent = subtitle;
    button.append(detail);
  }
  button.addEventListener('click', action);
  return button;
}

export function emptyList(container: HTMLElement, text: string): void {
  const empty = document.createElement('div');
  empty.className = 'empty-list';
  empty.textContent = text;
  container.append(empty);
}
