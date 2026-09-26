import { safeColor } from './review-utilities.ts';
import type * as Monaco from 'monaco-editor';

export interface CursorPresence {
  clientId: string;
  positionByte: number;
  color: string;
  user: string;
}

type CaretWidget = Monaco.editor.IContentWidget & { position: Monaco.IPosition | null };
type CaretEntry = { node: HTMLSpanElement; widget: CaretWidget };

export function createPresenceCursorLayer({ monaco, editor }: {
  monaco: typeof Monaco;
  editor: Monaco.editor.IStandaloneCodeEditor;
}) {
  const widgets = new Map<string, CaretEntry>();

  function remove(clientId: string) {
    const entry = widgets.get(clientId);
    if (!entry) return;
    editor.removeContentWidget(entry.widget);
    widgets.delete(clientId);
  }

  function create(clientId: string): CaretEntry {
    const node = document.createElement('span');
    node.className = 'remote-presence-caret';
    node.setAttribute('role', 'img');
    const widget: CaretWidget = {
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
    sync(presences: Iterable<CursorPresence>, resolvePosition: (positionByte: number) => Monaco.IPosition | null) {
      const active = new Set<string>();
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
