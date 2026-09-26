import { avatarElement } from './avatar-view.ts';
import { decodeBase64 } from './review-utilities.ts';

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export interface ReviewCardItem {
  id: string;
  kind: 'comment' | 'suggestion';
  status: string;
  author?: string;
  color?: string;
  avatarBase64?: string;
  createdAt?: string;
  summaryBase64?: string;
}

export interface ReviewCardMessage {
  author?: string;
  color?: string;
  avatarBase64?: string;
  createdAt?: string;
  bodyBase64?: string;
}

function formatDate(value: string | undefined): string {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? dateFormatter.format(parsed) : 'дата неизвестна';
}

export function cardButton<T extends ReviewCardItem>(label: string,
  action: (item: T, button: HTMLButtonElement) => void,
  item: T, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = label;
  button.className = className;
  button.addEventListener('click', () => action(item, button));
  return button;
}

export function cardHeader(item: ReviewCardItem): HTMLDivElement {
  const head = document.createElement('div');
  head.className = 'card-head';
  const identity = document.createElement('div');
  identity.className = 'card-identity';
  identity.append(avatarElement(item.author, item.color, item.avatarBase64));
  const authorBlock = document.createElement('div');
  const author = document.createElement('strong');
  author.textContent = item.author || 'Неизвестно';
  const date = document.createElement('time');
  date.dateTime = item.createdAt || '';
  date.textContent = formatDate(item.createdAt);
  authorBlock.append(author, date);
  identity.append(authorBlock);
  const badges = document.createElement('div');
  badges.className = 'card-badges';
  const badge = document.createElement('span');
  badge.className = `card-kind ${item.kind}`;
  badge.textContent = item.kind === 'suggestion' ? 'Правка' : 'Комментарий';
  const status = document.createElement('span');
  status.className = 'card-status';
  const labels: Record<string, string> = {
    open: 'открыто', resolved: 'закрыто', accepted: 'принято', rejected: 'отклонено',
    stale: 'устарело', orphaned: 'без привязки',
  };
  status.textContent = labels[item.status] ?? item.status;
  badges.append(badge, status);
  head.append(identity, badges);
  return head;
}

function messageElement(message: ReviewCardMessage, fallback: ReviewCardItem): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'thread-message';
  row.append(avatarElement(message.author, message.color, message.avatarBase64, 'avatar-small'));
  const content = document.createElement('div');
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('strong');
  author.textContent = message.author || fallback.author || 'Неизвестно';
  const date = document.createElement('time');
  date.dateTime = message.createdAt || fallback.createdAt || '';
  date.textContent = formatDate(message.createdAt || fallback.createdAt);
  meta.append(author, date);
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = decodeBase64(message.bodyBase64 ?? fallback.summaryBase64 ?? '');
  content.append(meta, body);
  row.append(content);
  return row;
}

export function renderMessages(card: HTMLElement, item: ReviewCardItem,
  messages: ReviewCardMessage[] | undefined): void {
  const thread = document.createElement('div');
  thread.className = 'thread';
  if (messages?.length) {
    for (const message of messages) thread.append(messageElement(message, item));
  } else if (item.kind === 'comment') {
    thread.append(messageElement({
      author: item.author, color: item.color, avatarBase64: item.avatarBase64,
      createdAt: item.createdAt, bodyBase64: item.summaryBase64,
    }, item));
  }
  if (thread.childElementCount) card.append(thread);
}
