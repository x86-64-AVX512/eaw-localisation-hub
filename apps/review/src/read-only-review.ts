import { requiredElement } from './dom-elements.ts';

interface ReadOnlyReviewOptions {
  data: { relativePath: string };
  editor: {
    updateOptions(options: { readOnly: boolean }): void;
    revealLineInCenter(line: number): void;
  };
  requestedLine: number;
  setStatus(message: string): void;
}

export function configureReadOnlyReview({ data, editor, requestedLine, setStatus }: ReadOnlyReviewOptions): void {
  editor.updateOptions({ readOnly: true });
  requiredElement<HTMLElement>('#workspace').classList.add('english-workspace');
  requiredElement<HTMLElement>('#collaboration-lane').hidden = true;
  requiredElement<HTMLElement>('#review-lane').hidden = true;
  requiredElement<HTMLElement>('.ticket-switcher').hidden = true;
  for (const control of document.querySelectorAll<HTMLElement>('.actions > button, .mode-switch')) control.hidden = true;
  requiredElement<HTMLElement>('#document-name').textContent = `${data.relativePath} · английский оригинал`;
  setStatus('Только чтение');
  if (requestedLine > 0) editor.revealLineInCenter(requestedLine);
}
