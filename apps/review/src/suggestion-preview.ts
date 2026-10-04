import type * as Monaco from 'monaco-editor';

export function activeSuggestionPreview(original: string, replacement: string): { zoneText: string; inlineTail: string } {
  // Monaco's Windows model may use CRLF. Normalize only the DOM preview, never
  // the projection offsets or the document sent to the server.
  original = original.replace(/\r\n|\r/gu, '\n');
  replacement = replacement.replace(/\r\n|\r/gu, '\n');
  const lastBreak = original.lastIndexOf('\n');
  // Deleting up to (but not including) the final newline leaves a real model
  // row for the caret. Reuse it for the last struck line instead of displaying
  // that line in a view zone and then adding an empty row underneath it.
  if (lastBreak >= 0 && !original.endsWith('\n') && !replacement.startsWith('\n')) {
    return { zoneText: original.slice(0, lastBreak), inlineTail: original.slice(lastBreak + 1) };
  }
  // A selected final newline belongs to the next model row; it is not another
  // deleted blank line. Remove just that boundary, preserving earlier blanks.
  return { zoneText: original.endsWith('\n') ? original.slice(0, -1) : original, inlineTail: '' };
}

// Monaco sets the outer view-zone width itself. Measure and constrain an inner
// element so wrapping stays identical before and after the zone is mounted.
export function suggestionPreview(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor,
  text: string, className: string, color: string): Pick<Monaco.editor.IViewZone, 'domNode' | 'heightInPx'> {
  text = text.replace(/\r\n|\r/gu, '\n');
  const font = editor.getOption(monaco.editor.EditorOption.fontInfo);
  const layout = editor.getLayoutInfo();
  const domNode = document.createElement('div');
  domNode.className = className;
  domNode.style.setProperty('--author-color', color);
  const content = document.createElement('div');
  Object.assign(content.style, {
    fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, fontWeight: font.fontWeight,
    lineHeight: `${font.lineHeight}px`, letterSpacing: `${font.letterSpacing}px`,
    width: `${Math.max(1, layout.contentWidth - layout.verticalScrollbarWidth)}px`,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minHeight: `${font.lineHeight}px`,
  });
  content.textContent = text;
  if (text.endsWith('\n')) {
    // A trailing newline has no line box in a plain pre-wrap text node. Keep
    // the actual blank separator without putting invisible text in copied
    // localisation or reserving an additional editable model row.
    const marker = document.createElement('span');
    marker.setAttribute('aria-hidden', 'true');
    Object.assign(marker.style, { display: 'block', width: '0', height: `${font.lineHeight}px` });
    content.append(marker);
  }
  domNode.append(content);
  Object.assign(domNode.style, { position: 'absolute', visibility: 'hidden' });
  editor.getDomNode()!.append(domNode);
  const heightInPx = Math.ceil(Math.max(font.lineHeight, content.getBoundingClientRect().height));
  domNode.remove();
  domNode.style.removeProperty('position');
  domNode.style.removeProperty('visibility');
  return { domNode, heightInPx };
}
