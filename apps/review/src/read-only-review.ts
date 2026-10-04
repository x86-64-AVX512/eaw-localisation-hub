import { uiText } from '../../../packages/shared/src/ui-language.mts';
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
  requiredElement<HTMLElement>('.appbar').classList.add('readonly-workbench');
  requiredElement<HTMLElement>('#workspace').classList.add('english-workspace');
  requiredElement<HTMLElement>('#collaboration-lane').hidden = true;
  requiredElement<HTMLElement>('#review-lane').hidden = true;
  requiredElement<HTMLElement>('.ticket-switcher').hidden = true;
  for (const control of document.querySelectorAll<HTMLElement>('.actions, .actions > button, .mode-switch, .undo-group, .pane-switches')) control.hidden = true;
  requiredElement<HTMLElement>('#document-name').textContent = uiText("{0} · английский оригинал", data.relativePath);
  setStatus(uiText("Только чтение"));
  if (requestedLine > 0) editor.revealLineInCenter(requestedLine);
}
