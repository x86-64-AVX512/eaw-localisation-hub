// Keep the native select as the form/controller source of truth, but draw its
// popup ourselves: Windows/WebView2 may paint native options white even when
// the application uses a dark theme. Popovers escape clipping and modal stacking.
export function createThemedSelects() {
  const controls = new Map<HTMLSelectElement, { refresh(): void; dispose(): void }>();
  let current: (() => void) | undefined;
  let pending = false;
  let disposed = false;

  function enhance(select: HTMLSelectElement) {
    if (select.multiple || select.size > 1 || controls.has(select)) return;
    const wrapper = document.createElement('span'); wrapper.className = 'themed-select';
    if (select.id) wrapper.dataset.select = select.id;
    const trigger = document.createElement('button'); trigger.type = 'button';
    trigger.className = 'themed-select-trigger'; trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span'); trigger.append(label);
    const popup = document.createElement('div'); popup.className = 'themed-select-popup';
    popup.id = `select-popup-${select.id || crypto.randomUUID()}`; popup.popover = 'manual';
    popup.setAttribute('role', 'listbox'); trigger.setAttribute('aria-controls', popup.id);
    select.before(wrapper); wrapper.append(trigger);
    (select.closest('dialog') ?? document.body).append(popup);
    const oldTabIndex = select.tabIndex, oldAria = select.getAttribute('aria-hidden');
    select.tabIndex = -1; select.setAttribute('aria-hidden', 'true'); select.classList.add('themed-select-source');
    let open = false, active = -1, signature = '', search = '', searchAt = 0;
    const enabled = () => [...select.options].map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.hidden && !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled));
    function close() {
      if (open) popup.hidePopover(); open = false; trigger.setAttribute('aria-expanded', 'false');
      popup.dataset.reviewOverlay = 'false';
      trigger.removeAttribute('aria-activedescendant'); if (current === close) current = undefined;
    }
    function highlight(index: number) {
      active = index;
      for (const row of popup.querySelectorAll<HTMLElement>('[role="option"]')) row.classList.toggle('highlighted', Number(row.dataset.index) === index);
      const row = popup.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (row) { trigger.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
    }
    function choose(index: number) {
      if (!enabled().some(item => item.index === index) || select.disabled) return;
      const previous = select.selectedIndex; select.selectedIndex = index;
      close(); trigger.focus(); refresh();
      if (previous !== index) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function position() {
      if (!open) return;
      const rect = trigger.getBoundingClientRect();
      const height = Math.min(320, Math.max(72, popup.scrollHeight), innerHeight - 16);
      const below = innerHeight - rect.bottom - 8;
      const top = below >= Math.min(height, 120) ? rect.bottom + 4 : Math.max(8, rect.top - height - 4);
      Object.assign(popup.style, { left: `${Math.max(8, Math.min(rect.left, innerWidth - Math.max(rect.width, 260) - 8))}px`,
        top: `${top}px`, minWidth: `${Math.max(160, Math.min(rect.width, innerWidth - 16))}px`,
        maxWidth: `${innerWidth - 16}px`, maxHeight: `${Math.max(40, Math.min(height, innerHeight - top - 8))}px` });
    }
    function refresh() {
      wrapper.hidden = select.hidden; trigger.disabled = select.disabled;
      const name = select.getAttribute('aria-label') || [...select.labels ?? []].map(item => item.textContent?.trim()).join(' ') || select.title;
      if (name) trigger.setAttribute('aria-label', name);
      trigger.title = select.selectedOptions[0]?.textContent?.trim() || select.title;
      label.textContent = select.selectedOptions[0]?.textContent || '';
      if (select.hidden || select.disabled) close();
      const next = JSON.stringify([...select.options].map(option => [option.value, option.textContent, option.disabled, option.hidden, option.selected, option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled]));
      if (next !== signature) {
        signature = next; popup.replaceChildren();
        const enabledIndices = new Set(enabled().map(item => item.index));
        [...select.options].forEach((option, index) => {
          if (option.hidden) return;
          const row = document.createElement('button'); row.type = 'button'; row.setAttribute('role', 'option');
          row.id = `${popup.id}-${index}`; row.dataset.index = String(index);
          row.textContent = option.textContent; row.disabled = !enabledIndices.has(index);
          row.setAttribute('aria-selected', String(option.selected)); row.tabIndex = -1;
          row.addEventListener('pointermove', () => { if (!row.disabled) highlight(index); });
          row.addEventListener('pointerdown', event => event.preventDefault());
          row.addEventListener('click', () => choose(index)); popup.append(row);
        });
        if (open) highlight(enabled().some(item => item.index === active) ? active : select.selectedIndex);
      }
      position();
    }
    function show() {
      if (select.disabled || select.hidden || !enabled().length) return;
      current?.(); refresh(); open = true; current = close; popup.showPopover();
      popup.dataset.reviewOverlay = 'true';
      trigger.setAttribute('aria-expanded', 'true'); position(); highlight(select.selectedIndex);
    }
    trigger.addEventListener('click', () => open ? close() : show());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === 'Tab') { close(); return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); if (!open) show(); const choices = enabled();
        const index = choices.findIndex(item => item.index === active);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
        if (choices[next]) highlight(choices[next].index);
      } else if (['Enter', ' '].includes(event.key)) {
        event.preventDefault(); if (open) choose(active); else show();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); if (!open) show();
        search = Date.now() - searchAt < 800 ? search + event.key : event.key; searchAt = Date.now();
        const found = enabled().find(({ option }) => option.text.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
        if (found) highlight(found.index);
      }
    });
    trigger.addEventListener('blur', close);
    const focus = () => trigger.focus(); select.addEventListener('focus', focus);
    const observer = new MutationObserver(refresh); observer.observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
    const properties = ['value', 'selectedIndex'] as const;
    for (const property of properties) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property)!;
      Object.defineProperty(select, property, { configurable: true, get() { return descriptor.get!.call(this); },
        set(value: unknown) { descriptor.set!.call(this, value); refresh(); } });
    }
    select.addEventListener('change', refresh);
    controls.set(select, { refresh, dispose() {
      close(); observer.disconnect(); select.removeEventListener('change', refresh); select.removeEventListener('focus', focus);
      for (const property of properties) delete (select as unknown as Record<string, unknown>)[property];
      select.tabIndex = oldTabIndex; if (oldAria === null) select.removeAttribute('aria-hidden'); else select.setAttribute('aria-hidden', oldAria);
      select.classList.remove('themed-select-source'); wrapper.remove(); popup.remove();
    } });
    refresh();
  }
  const scan = () => {
    if (disposed) return;
    pending = false; document.querySelectorAll<HTMLSelectElement>('select').forEach(enhance);
    for (const [select, control] of controls) if (!select.isConnected) { control.dispose(); controls.delete(select); }
  };
  const observer = new MutationObserver(() => { if (!pending) { pending = true; queueMicrotask(scan); } });
  observer.observe(document.body, { childList: true, subtree: true }); scan();
  const outside = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.themed-select, .themed-select-popup')) current?.(); };
  const reposition = (event: Event) => {
    if (event.target instanceof Element && event.target.closest('.themed-select-popup')) return;
    current?.();
  };
  document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
  return { dispose() { disposed = true; observer.disconnect(); current?.(); for (const control of controls.values()) control.dispose(); controls.clear();
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', reposition); document.removeEventListener('scroll', reposition, true); } };
}
