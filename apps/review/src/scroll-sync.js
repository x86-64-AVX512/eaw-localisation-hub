export function keyAtLine(model, lineNumber) {
  for (let line = Math.max(1, lineNumber); line >= Math.max(1, lineNumber - 8); line -= 1) {
    const match = /^\s*([^#\s][^:]*?):\d+\s/u.exec(model.getLineContent(line));
    if (match) return match[1].trim();
  }
  return '';
}

export function lineForKey(model, key) {
  for (let line = 1; line <= model.getLineCount(); line += 1) {
    const match = /^\s*([^#\s][^:]*?):\d+\s/u.exec(model.getLineContent(line));
    if (match?.[1]?.trim() === key) return line;
  }
  return 0;
}

export function createScrollSync({ editor, initialPair = '' }) {
  const control = document.querySelector('#scroll-sync-control');
  const enabled = document.querySelector('#scroll-sync-enabled');
  let channel = null;
  let pair = '';
  let applying = false;

  function setPair(nextPair) {
    channel?.close(); channel = null;
    pair = String(nextPair ?? '');
    control.hidden = !pair;
    if (!pair) return;
    enabled.checked = true;
    channel = new BroadcastChannel(`eaw-review-scroll-${pair}`);
    channel.addEventListener('message', (event) => {
      if (!enabled.checked || event.data?.type !== 'scroll' || !event.data.key) return;
      const line = lineForKey(editor.getModel(), event.data.key);
      if (!line) return;
      applying = true;
      editor.setScrollTop(editor.getTopForLineNumber(line));
      requestAnimationFrame(() => { applying = false; });
    });
  }

  const subscription = editor.onDidScrollChange(() => {
    if (!channel || !enabled.checked || applying) return;
    const line = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
    const key = keyAtLine(editor.getModel(), line);
    if (key) channel.postMessage({ type: 'scroll', key });
  });
  setPair(initialPair);
  return { setPair, dispose() { subscription.dispose(); channel?.close(); } };
}
