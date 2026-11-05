import { uiText } from '../../../packages/shared/src/ui-language.mts';
import { avatarElement } from './avatar-view.ts';
import { requiredElement } from './dom-elements.ts';
import { emptyList } from './list-items.ts';
import { safeColor } from './review-utilities.ts';
import type { CollaborationPanelOptions, ReviewReservation } from './review-state.ts';

interface ReservationGroup {
  node: HTMLDetailsElement;
  profile: HTMLElement;
  profileKey: string;
  count: HTMLElement;
  entries: HTMLElement;
}

const groupKey = (item: ReviewReservation) => item.assigneeId ? `id:${item.assigneeId}` : `name:${item.assignee}`;

function orderChildren(container: HTMLElement, nodes: HTMLElement[]): void {
  nodes.forEach((node, index) => {
    const current = container.children[index] ?? null;
    if (current !== node) container.insertBefore(node, current);
  });
  while (container.children.length > nodes.length) container.lastElementChild?.remove();
}

export function createReservationList({
  state, jumpToBytes, showToast, deleteReservation, onSelect,
}: Pick<CollaborationPanelOptions, 'state' | 'jumpToBytes' | 'showToast'> & {
  deleteReservation: HTMLButtonElement;
  onSelect: () => void;
}) {
  const reservationList = requiredElement<HTMLElement>('#reservation-list');
  const reservationCount = requiredElement<HTMLElement>('#reservation-count');
  const reservationGroups = new Map<string, ReservationGroup>();
  const reservationNodes = new Map<string, HTMLButtonElement>();
  let selectedGroup = '';

  function reservationButton(item: ReviewReservation): HTMLButtonElement {
    let button = reservationNodes.get(item.id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'reservation-entry';
      button.addEventListener('click', () => {
        const current = state.reservations.get(item.id);
        if (!current) return;
        state.selectedReservation = item.id;
        deleteReservation.disabled = false;
        renderReservations();
        onSelect();
        if (current.status !== 'orphaned') {
          try { jumpToBytes(current.startByte, current.endByte); }
          catch { showToast(uiText("Границы брони обновляются."), true); }
        }
      });
      reservationNodes.set(item.id, button);
    }
    const label = [
      uiText("Ключей: {0}", item.keyCount),
      item.status === 'orphaned' ? uiText("границы потеряны") : item.status === 'empty' ? uiText("пустой диапазон") : '',
      item.createdBy && item.createdBy !== item.assignee ? uiText("создал {0}", item.createdBy) : '',
      item.comment,
    ].filter(Boolean).join(' · ');
    if (button.textContent !== label) button.textContent = label;
    button.style.setProperty('--item-color', safeColor(item.color));
    button.setAttribute('aria-pressed', String(state.selectedReservation === item.id));
    return button;
  }

  function reservationGroup(id: string): ReservationGroup {
    const existing = reservationGroups.get(id);
    if (existing) return existing;

    const node = document.createElement('details');
    node.className = 'reservation-group';
    const summary = document.createElement('summary');
    const profile = document.createElement('span');
    profile.className = 'reservation-group-profile';
    const count = document.createElement('span');
    count.className = 'reservation-group-count';
    summary.append(profile, count);
    const entries = document.createElement('div');
    entries.className = 'reservation-group-entries';
    node.append(summary, entries);
    // «Удалить выбранную» acts at once, so a collapsed group must not keep a hidden target.
    node.addEventListener('toggle', () => {
      const selected = reservationNodes.get(state.selectedReservation);
      if (node.open || !selected || !entries.contains(selected)) return;
      state.selectedReservation = '';
      deleteReservation.disabled = true;
      selected.setAttribute('aria-pressed', 'false');
      onSelect();
    });
    const group = { node, profile, profileKey: '', count, entries };
    reservationGroups.set(id, group);
    return group;
  }

  function renderReservations() {
    const previousScrollTop = reservationList.scrollTop;
    const values = [...state.reservations.values()].sort((left, right) => left.startByte - right.startByte);
    const byAssignee = new Map<string, ReviewReservation[]>();
    for (const item of values) {
      const id = groupKey(item);
      const items = byAssignee.get(id);
      if (items) items.push(item);
      else byAssignee.set(id, [item]);
    }
    const targets = new Map(state.reservationTargets.map((target) => [target.id, target]));
    const groups: HTMLElement[] = [];
    for (const [id, items] of byAssignee) {
      const { assignee, assigneeId, color } = items[0];
      const avatar = targets.get(assigneeId)?.avatarBase64 ?? '';
      const group = reservationGroup(id);
      const profileKey = JSON.stringify([assignee, color, avatar]);
      if (group.profileKey !== profileKey) {
        const name = document.createElement('span');
        name.className = 'reservation-group-name';
        name.textContent = assignee;
        name.title = assignee;
        group.profile.replaceChildren(avatarElement(assignee, color, avatar, 'avatar-small'), name);
        group.profileKey = profileKey;
      }
      group.count.textContent = uiText("Броней: {0}", items.length);
      orderChildren(group.entries, items.map(reservationButton));
      groups.push(group.node);
    }
    for (const id of reservationGroups.keys()) if (!byAssignee.has(id)) reservationGroups.delete(id);
    for (const id of reservationNodes.keys()) if (!state.reservations.has(id)) reservationNodes.delete(id);
    if (!groups.length) {
      if (!reservationList.firstElementChild?.classList.contains('empty-list')) {
        reservationList.replaceChildren(); emptyList(reservationList, uiText("Броней нет."));
      }
    } else {
      orderChildren(reservationList, groups);
    }
    if (!state.reservations.has(state.selectedReservation)) {
      state.selectedReservation = '';
      deleteReservation.disabled = true;
    }
    reservationList.scrollTop = previousScrollTop;
    // A reassigned reservation moves to another, possibly collapsed or new group
    // without a toggle event; open that group and show the selected (deletable) row.
    // Only an actual move reopens a group, so a render between a user's collapse
    // and its asynchronous toggle event cannot undo the collapse.
    const selectedItem = state.reservations.get(state.selectedReservation);
    const group = selectedItem ? groupKey(selectedItem) : '';
    const row = reservationNodes.get(state.selectedReservation);
    const holder = row?.closest('details');
    if (group !== selectedGroup && holder) {
      // The target group may already be open but scrolled out of view.
      if (!holder.open) holder.open = true;
      row!.scrollIntoView({ block: 'nearest' });
    }
    selectedGroup = group;
    reservationCount.textContent = String(values.length);
  }

  // «Удалить выбранную» deletes at once: only a row the user can see may be its target.
  function selectedVisible(): boolean {
    const row = reservationNodes.get(state.selectedReservation);
    return Boolean(row?.isConnected && row.closest('details')?.open);
  }

  return Object.assign(renderReservations, { selectedVisible });
}
