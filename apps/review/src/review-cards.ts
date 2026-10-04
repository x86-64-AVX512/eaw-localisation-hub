import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { decodeBase64, encodeBase64, safeColor } from './review-utilities.ts';
import { canEditDocument, canDecideSuggestions } from '../../../packages/shared/src/document-permissions.mts';
import { cardButton, cardHeader, renderMessages } from './review-card-elements.ts';
import type { ReviewCardMessage } from './review-card-elements.ts';
import { suggestionTraceParts } from '../../../packages/shared/src/suggestion-trace.mts';
import { confirmAction } from './confirm-action.ts';
import { createReviewCardLayout } from './review-card-layout.ts';
import { requiredElement, requiredInput } from './dom-elements.ts';
import type { CardItem, ReviewCardsOptions } from './review-card-types.ts';

export function visibleComparisonText(text: unknown): string {
  const value = String(text ?? '');
  if (!/^(?:\r\n|\r|\n)+$/u.test(value)) return value;
  const count = (value.match(/\r\n|\r|\n/gu) ?? []).length;
  return count === 1 ? uiText("[перенос строки]") : uiText("[переносы строк: {0}]", count);
}

export function reviewCardFingerprint(item: { id: string; startByte: number; endByte: number },
  messages: unknown[] | undefined, editingSuggestionId: string, userId: string): string {
  const { startByte, endByte, ...content } = item;
  return JSON.stringify([content, messages ?? [], item.id === editingSuggestionId, userId]);
}

export function createReviewCards({
  state, editor, rangeFromBytes, send, askText, showToast = () => {}, onEditSuggestion = (_item) => false,
  onAcceptSuggestion = (_item) => {}, onRevertSuggestion = (_item) => {},
}: ReviewCardsOptions) {
  const cards = requiredElement<HTMLElement>('#cards');
  const empty = requiredElement<HTMLElement>('#empty-review');
  const count = requiredElement<HTMLElement>('#review-count');
  const connectors = requiredElement<HTMLElement>('#connectors');
  const showAccepted = requiredInput('#show-accepted-suggestions');
  const lane = requiredElement<HTMLElement>('#review-lane');
  const cardLayout = createReviewCardLayout({ state, editor, rangeFromBytes, cards, connectors, lane });
  const cardCache = new Map<string, { card: HTMLElement; fingerprint: string; item: CardItem }>();
  let focusTimer: ReturnType<typeof setTimeout> | undefined;

  async function reply(type: CardItem['kind'], item: CardItem): Promise<void> {
    const body = await askText(uiText("Ответить"), uiText("Сообщение"));
    const command = type === 'comment' ? 'commentReply' : 'suggestionReply';
    if (body?.trim()) send({ type: command, path: state.path, id: item.id, bodyBase64: encodeBase64(body.trim()) });
  }

  function createCard(item: CardItem, messages: ReviewCardMessage[] | undefined): HTMLElement {
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
        oldText.textContent = original || uiText("[вставка]");
        if (!original) oldText.classList.add('empty-marker');
        const newText = document.createElement('ins');
        newText.textContent = replacement || uiText("[удалить]");
        if (!replacement) newText.classList.add('empty-marker');
        comparison.append(oldText, newText);
      }
      card.append(comparison);
    }
    renderMessages(card, item, messages, showToast);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(cardButton(uiText("Ответить"), (value) => reply(item.kind, value), item));
    if (item.kind === 'suggestion' && item.status === 'open') {
      const ownSuggestion = item.authorId ? item.authorId === state.userId : item.author === state.user;
      if (ownSuggestion && canEditDocument(state, state.relativePath ?? '')) actions.append(cardButton(
        item.id === state.editingSuggestionId ? uiText("Редактируется") : uiText("Редактировать"),
        (value) => onEditSuggestion(value), item,
      ));
      if (canDecideSuggestions(state)) actions.append(
        cardButton(uiText("Принять"), onAcceptSuggestion, item),
        cardButton(uiText("Отклонить"), (value) => send({ type: 'suggestionReject', path: state.path, id: value.id }), item),
      );
    }
    if (item.kind === 'suggestion' && item.status === 'accepted' && canDecideSuggestions(state)) {
      actions.append(cardButton(uiText("Отменить принятие"), onRevertSuggestion, item));
    }
    if (item.kind === 'comment' && canEditDocument(state, state.relativePath ?? '')) {
      const nextStatus = item.status === 'resolved' ? 'open' : 'resolved';
      actions.append(cardButton(item.status === 'resolved' ? uiText("Вернуть") : uiText("Закрыть"),
        (value) => send({ type: 'commentStatus', path: state.path, id: value.id, status: nextStatus }), item));
    }
    const deleteType = item.kind === 'comment' ? 'commentDelete' : 'suggestionDelete';
    if (canEditDocument(state, state.relativePath ?? '')) actions.append(cardButton(uiText("Удалить"), async (value, button) => {
      if (await confirmAction(button, item.kind === 'comment' ? uiText("Удалить комментарий и ответы?") : uiText("Удалить правку и ответы?"), { label: uiText("Удалить"), danger: true })) {
        button.disabled = true;
        send({ type: deleteType, path: state.path, id: value.id });
        setTimeout(() => { if (button.isConnected) button.disabled = false; }, 5000);
      }
    }, item, 'danger'));
    card.append(actions);
    card.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('button, .thread, .comparison')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.anchorNode && card.contains(selection.anchorNode)) return;
      const range = rangeFromBytes(item.startByte, item.endByte);
      editor.revealRangeInCenter(range);
      editor.setSelection(range);
      editor.focus();
    });
    return card;
  }

  function render() {
    const items = [
      ...[...state.comments.values()].map((item) => ({ ...item, kind: 'comment' as const })),
      ...[...state.suggestions.values()].map((item) => ({ ...item, kind: 'suggestion' as const })),
    ].filter((item) => item.kind !== 'suggestion' || item.status !== 'accepted' || showAccepted.checked)
      .sort((left, right) => left.startByte - right.startByte);
    count.textContent = String(items.length);
    empty.hidden = items.length !== 0;
    const liveKeys = new Set<string>();
    const nodes = items.map((item) => {
      const key = `${item.kind}:${item.id}`;
      const messages = item.kind === 'suggestion'
        ? state.suggestionMessages.get(item.id) : state.commentMessages.get(item.id);
      const fingerprint = reviewCardFingerprint(item, messages, state.editingSuggestionId, state.userId)
        + JSON.stringify(state.roles ?? []);
      liveKeys.add(key);
      const cached = cardCache.get(key);
      if (cached?.fingerprint === fingerprint) {
        cached.item.startByte = item.startByte;
        cached.item.endByte = item.endByte;
        cached.card.dataset.startByte = String(item.startByte);
        return cached.card;
      }
      const card = createCard(item, messages);
      cardCache.set(key, { card, fingerprint, item });
      return card;
    });
    for (const key of cardCache.keys()) if (!liveKeys.has(key)) cardCache.delete(key);
    nodes.forEach((node, index) => {
      const current = cards.children[index] ?? null;
      if (current !== node) cards.insertBefore(node, current);
    });
    while (cards.children.length > nodes.length) cards.lastElementChild?.remove();
    cardLayout.layout();
  }

  showAccepted.addEventListener('change', render);

  function focusCard(kind: CardItem['kind'], id: string): boolean {
    const card = [...cards.querySelectorAll<HTMLElement>('article')]
      .find((candidate) => candidate.dataset.itemKey === `${kind}:${id}`);
    if (!card) return false;
    clearTimeout(focusTimer);
    for (const candidate of cards.children) candidate.classList.remove('review-card-focused');
    card.classList.add('review-card-focused');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.focus({ preventScroll: true });
    focusTimer = setTimeout(() => card.classList.remove('review-card-focused'), 1800);
    cardLayout.layout();
    return true;
  }

  return { render, layout: cardLayout.layout, syncScroll: cardLayout.syncScroll, focusCard };
}
