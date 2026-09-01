import { avatarElement } from './avatar-view.js';
import { decodeBase64 } from './review-utilities.js';

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function formatDate(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? dateFormatter.format(parsed) : 'дата неизвестна';
}

export function cardButton(label, action, item, className = '') {
  const button = document.createElement('button');
  button.textContent = label;
  button.className = className;
  button.addEventListener('click', () => action(item));
  return button;
}

export function cardHeader(item) {
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
  status.textContent = ({
    open: 'открыто', resolved: 'закрыто', accepted: 'принято', rejected: 'отклонено',
    stale: 'устарело', orphaned: 'без привязки',
  })[item.status] ?? item.status;
  badges.append(badge, status);
  head.append(identity, badges);
  return head;
}

function messageElement(message, fallback) {
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

export function renderMessages(card, item, messages) {
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
