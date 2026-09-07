function visibleChildren(element) {
  return [...element.children].filter((child) => !child.hidden && getComputedStyle(child).display !== 'none');
}

function unwrappedWidth(element) {
  const children = visibleChildren(element);
  const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
  return children.reduce((width, child) => width + child.getBoundingClientRect().width, 0)
    + Math.max(0, children.length - 1) * gap;
}

export function createAppbarLayout(appbar) {
  const ticketSwitcher = appbar.querySelector('.ticket-switcher');
  const actions = appbar.querySelector('.actions');
  let frame = 0;

  function refresh() {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      const style = getComputedStyle(appbar);
      const availableWidth = appbar.clientWidth
        - (Number.parseFloat(style.paddingLeft) || 0)
        - (Number.parseFloat(style.paddingRight) || 0);
      const columnGap = Number.parseFloat(style.columnGap) || 0;
      const brandWidth = Math.max(420, unwrappedWidth(ticketSwitcher));
      const actionsWidth = unwrappedWidth(actions);
      appbar.classList.toggle('appbar-stacked', brandWidth + columnGap + actionsWidth > availableWidth);
    });
  }

  const resizeObserver = new ResizeObserver(refresh);
  resizeObserver.observe(appbar);
  const mutationObserver = new MutationObserver(refresh);
  mutationObserver.observe(appbar, {
    attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true,
  });
  document.fonts?.ready.then(refresh);
  refresh();

  return {
    refresh,
    dispose() {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    },
  };
}
