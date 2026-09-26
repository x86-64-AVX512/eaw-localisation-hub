import { requiredElement } from './dom-elements.ts';

interface LineModel {
  getLineContent(line: number): string;
  getLineCount(): number;
}
interface ScrollEditor {
  getModel(): LineModel | null;
  setScrollTop(top: number): void;
  getTopForLineNumber(line: number): number;
  getVisibleRanges(): { startLineNumber: number }[];
  onDidScrollChange(listener: () => void): { dispose(): void };
}

export function keyAtLine(model: LineModel, lineNumber: number): string {
  for (let line = Math.max(1, lineNumber); line >= Math.max(1, lineNumber - 8); line -= 1) {
    const match = /^\s*([^#\s][^:]*?):(?:\d+)?\s/u.exec(model.getLineContent(line));
    if (match) return match[1].trim();
  }
  return '';
}

export function lineForKey(model: LineModel, key: string): number {
  for (let line = 1; line <= model.getLineCount(); line += 1) {
    const match = /^\s*([^#\s][^:]*?):(?:\d+)?\s/u.exec(model.getLineContent(line));
    if (match?.[1]?.trim() === key) return line;
  }
  return 0;
}

export function createScrollSync({ editor, initialPair = '' }: { editor: ScrollEditor; initialPair?: string }) {
  const control = requiredElement<HTMLElement>('#scroll-sync-control');
  const enabled = requiredElement<HTMLInputElement>('#scroll-sync-enabled');
  let channel: BroadcastChannel | null = null;
  let pair = '';
  let applying = false;

  function setPair(nextPair: string): void {
    channel?.close(); channel = null;
    pair = String(nextPair ?? '');
    control.hidden = !pair;
    if (!pair) return;
    enabled.checked = true;
    channel = new BroadcastChannel(`eaw-review-scroll-${pair}`);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!enabled.checked || !data || typeof data !== 'object') return;
      const message = data as Record<string, unknown>;
      if (message.type !== 'scroll' || typeof message.key !== 'string' || !message.key) return;
      const model = editor.getModel();
      if (!model) return;
      const line = lineForKey(model, message.key);
      if (!line) return;
      applying = true;
      editor.setScrollTop(editor.getTopForLineNumber(line));
      requestAnimationFrame(() => { applying = false; });
    });
  }

  const subscription = editor.onDidScrollChange(() => {
    if (!channel || !enabled.checked || applying) return;
    const line = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
    const model = editor.getModel();
    if (!model) return;
    const key = keyAtLine(model, line);
    if (key) channel.postMessage({ type: 'scroll', key });
  });
  setPair(initialPair);
  return { setPair, dispose() { subscription.dispose(); channel?.close(); } };
}
