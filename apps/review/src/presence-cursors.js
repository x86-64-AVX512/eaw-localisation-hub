import { safeColor } from './review-utilities.js';

export function createPresenceCursorLayer({ monaco, editor }) {
  const widgets = new Map();

  function remove(clientId) {
    const entry = widgets.get(clientId);
    if (!entry) return;
    editor.removeContentWidget(entry.widget);
    widgets.delete(clientId);
  }

  function create(clientId) {
    const node = document.createElement('span');
    node.className = 'remote-presence-caret';
    node.setAttribute('role', 'img');
    const widget = {
      position: null,
      getId: () => `eaw.remote-caret.${clientId}`,
      getDomNode: () => node,
      getPosition: () => widget.position && ({
        position: widget.position,
        preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
      }),
      suppressMouseDown: true,
    };
    const entry = { node, widget };
    widgets.set(clientId, entry);
    editor.addContentWidget(widget);
    return entry;
  }

  return {
    sync(presences, resolvePosition) {
      const active = new Set();
      for (const presence of presences) {
        let position;
        try { position = resolvePosition(presence.positionByte); } catch { position = null; }
        if (!position) {
          remove(presence.clientId);
          continue;
        }
        active.add(presence.clientId);
        const entry = widgets.get(presence.clientId) ?? create(presence.clientId);
        const color = safeColor(presence.color);
        entry.node.style.setProperty('--presence-color', color);
        entry.node.title = presence.user;
        entry.node.setAttribute('aria-label', `Курсор: ${presence.user}`);
        entry.widget.position = position;
        editor.layoutContentWidget(entry.widget);
      }
      for (const clientId of widgets.keys()) {
        if (!active.has(clientId)) remove(clientId);
      }
    },
  };
}
