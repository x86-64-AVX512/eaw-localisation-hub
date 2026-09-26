let active: { cancel(): void } | null = null;

export function confirmAction(anchor: EventTarget | null, message: string,
  { label = 'Подтвердить', danger = false }: { label?: string; danger?: boolean } = {}): Promise<boolean> {
  active?.cancel();
  if (!(anchor instanceof HTMLElement) || !anchor.isConnected || ('disabled' in anchor && anchor.disabled)) {
    return Promise.resolve(false);
  }
  const trigger = anchor;
  return new Promise<boolean>((resolve) => {
    const panel = document.createElement('div');
    panel.className = 'confirm-action';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', message);
    panel.setAttribute('popover', 'manual');
    const text = document.createElement('div'); text.textContent = message;
    const actions = document.createElement('div'); actions.className = 'confirm-action-buttons';
    const accept = document.createElement('button'); accept.type = 'button'; accept.textContent = label;
    accept.className = danger ? 'danger' : 'primary';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Отмена';
    actions.append(accept, cancel); panel.append(text, actions);
    // A confirmation inside an existing modal must remain in its active subtree.
    const parent = trigger.closest('dialog') ?? document.body;
    parent.append(panel); panel.showPopover?.();
    const bounds = trigger.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(bounds.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, bounds.top >= panel.offsetHeight + 8
      ? bounds.top - panel.offsetHeight - 6 : Math.min(bounds.bottom + 6, innerHeight - panel.offsetHeight - 8))}px`;
    let finished = false;
    const observer = new MutationObserver(() => {
      if (!trigger.isConnected || ('disabled' in trigger && trigger.disabled)) finish(false);
    });
    function finish(value: boolean): void {
      if (finished) return;
      finished = true; observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      parent.removeEventListener('close', close);
      window.removeEventListener('resize', close);
      panel.remove(); active = null;
      if (trigger.isConnected && !('disabled' in trigger && trigger.disabled)) trigger.focus({ preventScroll: true });
      resolve(value);
    }
    function outside(event: PointerEvent): void { if (!(event.target instanceof Node) || !panel.contains(event.target)) finish(false); }
    function close() { finish(false); }
    function key(event: KeyboardEvent): void {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
      if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === accept ? cancel : accept).focus(); }
    }
    accept.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    parent.addEventListener('close', close);
    window.addEventListener('resize', close);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    active = { cancel: close }; cancel.focus();
  });
}
