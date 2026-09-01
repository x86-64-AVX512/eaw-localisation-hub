import { decodeBase64, encodeBase64, safeColor } from './review-utilities.js';
import { cardButton, cardHeader, renderMessages } from './review-card-elements.js';
import { suggestionTraceParts } from '../../../packages/shared/src/suggestion-trace.mjs';

export function visibleComparisonText(text) {
  const value = String(text ?? '');
  if (!/^(?:\r\n|\r|\n)+$/u.test(value)) return value;
  const count = (value.match(/\r\n|\r|\n/gu) ?? []).length;
  return count === 1 ? '[перенос строки]' : `[переносы строк: ${count}]`;
}

export function createReviewCards({
  state, editor, rangeFromBytes, send, askText, onEditSuggestion = () => false,
  onAcceptSuggestion = () => {}, onRevertSuggestion = () => {},
}) {
  const cards = document.querySelector('#cards');
  const empty = document.querySelector('#empty-review');
  const count = document.querySelector('#review-count');
  const connectors = document.querySelector('#connectors');
  const showAccepted = document.querySelector('#show-accepted-suggestions');
  const cardCache = new Map();
  let focusTimer;

  async function reply(type, item) {
    const body = await askText('Ответить', 'Сообщение');
    const command = type === 'comment' ? 'commentReply' : 'suggestionReply';
    if (body?.trim()) send({ type: command, path: state.path, id: item.id, bodyBase64: encodeBase64(body.trim()) });
  }

  function createCard(item, messages) {
    const card = document.createElement('article');
    card.className = `review-card ${item.kind}-card`;
    card.dataset.startByte = String(item.startByte);
    card.dataset.itemKey = `${item.kind}:${item.id}`;
    card.tabIndex = -1;
    card.style.setProperty('--author-color', safeColor(item.color));
    card.append(cardHeader(item));
    if (item.kind === 'suggestion') {
      const comparison = document.createElement('div');
      comparison.className = 'comparison';
      const original = decodeBase64(item.originalBase64);
      const replacement = decodeBase64(item.replacementBase64);
      if (item.traceJson) {
        comparison.classList.add('traced');
        for (const part of suggestionTraceParts(original, replacement, item.traceJson)) {
          const node = document.createElement(part.kind === 'delete' ? 'del'
            : part.kind === 'insert' ? 'ins' : 'span');
          node.textContent = visibleComparisonText(part.text);
          comparison.append(node);
        }
      } else {
        const oldText = document.createElement('del');
        oldText.textContent = original || '[вставка]';
        if (!original) oldText.classList.add('empty-marker');
        const newText = document.createElement('ins');
        newText.textContent = replacement || '[удалить]';
        if (!replacement) newText.classList.add('empty-marker');
        comparison.append(oldText, newText);
      }
      card.append(comparison);
    }
    renderMessages(card, item, messages);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(cardButton('Ответить', (value) => reply(item.kind, value), item));
    if (item.kind === 'suggestion' && item.status === 'open') {
      const ownSuggestion = item.authorId ? item.authorId === state.userId : item.author === state.user;
      if (ownSuggestion) actions.append(cardButton(
        item.id === state.editingSuggestionId ? 'Редактируется' : 'Редактировать',
        (value) => onEditSuggestion(value), item,
      ));
      actions.append(
        cardButton('Принять', onAcceptSuggestion, item),
        cardButton('Отклонить', (value) => send({ type: 'suggestionReject', path: state.path, id: value.id }), item),
      );
    }
    if (item.kind === 'suggestion' && item.status === 'accepted') {
      actions.append(cardButton('Отменить принятие', onRevertSuggestion, item));
    }
    if (item.kind === 'comment') {
      const nextStatus = item.status === 'resolved' ? 'open' : 'resolved';
      actions.append(cardButton(item.status === 'resolved' ? 'Вернуть' : 'Закрыть',
        (value) => send({ type: 'commentStatus', path: state.path, id: value.id, status: nextStatus }), item));
    }
    const deleteType = item.kind === 'comment' ? 'commentDelete' : 'suggestionDelete';
    actions.append(cardButton('Удалить', (value) => {
      if (confirm('Удалить это обсуждение без возможности восстановления?')) {
        send({ type: deleteType, path: state.path, id: value.id });
      }
    }, item, 'danger'));
    card.append(actions);
    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      const range = rangeFromBytes(item.startByte, item.endByte);
      editor.revealRangeInCenter(range);
      editor.setSelection(range);
      editor.focus();
    });
    return card;
  }

  function render() {
    const items = [
      ...[...state.comments.values()].map((item) => ({ ...item, kind: 'comment' })),
      ...[...state.suggestions.values()].map((item) => ({ ...item, kind: 'suggestion' })),
    ].filter((item) => item.kind !== 'suggestion' || item.status !== 'accepted' || showAccepted.checked)
      .sort((left, right) => left.startByte - right.startByte);
    count.textContent = String(items.length);
    empty.hidden = items.length !== 0;
    const liveKeys = new Set();
    const nodes = items.map((item) => {
      const key = `${item.kind}:${item.id}`;
      const messages = item.kind === 'suggestion'
        ? state.suggestionMessages.get(item.id) : state.commentMessages.get(item.id);
      const fingerprint = JSON.stringify([item, messages ?? [], item.id === state.editingSuggestionId, state.userId]);
      liveKeys.add(key);
      const cached = cardCache.get(key);
      if (cached?.fingerprint === fingerprint) return cached.card;
      const card = createCard(item, messages);
      cardCache.set(key, { card, fingerprint });
      return card;
    });
    for (const key of cardCache.keys()) if (!liveKeys.has(key)) cardCache.delete(key);
    nodes.forEach((node, index) => {
      const current = cards.children[index] ?? null;
      if (current !== node) cards.insertBefore(node, current);
    });
    while (cards.children.length > nodes.length) cards.lastElementChild.remove();
    requestAnimationFrame(layout);
  }

  showAccepted.addEventListener('change', render);

  function layout() {
    if (!state.path) return;
    const editorRect = document.querySelector('#editor').getBoundingClientRect();
    const workspaceRect = document.querySelector('#workspace').getBoundingClientRect();
    const laneRect = document.querySelector('#review-lane').getBoundingClientRect();
    connectors.replaceChildren();
    for (const card of cards.children) {
      let position;
      try { position = rangeFromBytes(Number(card.dataset.startByte), Number(card.dataset.startByte)).getStartPosition(); }
      catch { continue; }
      const visible = editor.getScrolledVisiblePosition(position);
      if (!visible || visible.top < -30 || visible.top > editorRect.height) continue;
      const cardRect = card.getBoundingClientRect();
      if (cardRect.bottom < laneRect.top + 38 || cardRect.top > laneRect.bottom) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const startX = editorRect.right - workspaceRect.left - 8;
      const startY = visible.top + visible.height / 2;
      const endX = laneRect.left - workspaceRect.left + 10;
      const endY = cardRect.top - workspaceRect.top + Math.min(30, card.offsetHeight / 2);
      line.setAttribute('d', `M ${startX} ${startY} C ${startX + 28} ${startY}, ${endX - 28} ${endY}, ${endX} ${endY}`);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', getComputedStyle(card).getPropertyValue('--author-color'));
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('opacity', '.8');
      connectors.append(line);
    }
  }

  function focusCard(kind, id) {
    const card = [...cards.children]
      .find((candidate) => candidate.dataset.itemKey === `${kind}:${id}`);
    if (!card) return false;
    clearTimeout(focusTimer);
    for (const candidate of cards.children) candidate.classList.remove('review-card-focused');
    card.classList.add('review-card-focused');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.focus({ preventScroll: true });
    focusTimer = setTimeout(() => card.classList.remove('review-card-focused'), 1800);
    requestAnimationFrame(layout);
    return true;
  }

  return { render, layout, focusCard };
}
