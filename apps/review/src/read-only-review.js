export function configureReadOnlyReview({ data, editor, requestedLine, setStatus }) {
  editor.updateOptions({ readOnly: true });
  document.querySelector('#workspace').classList.add('english-workspace');
  document.querySelector('#collaboration-lane').hidden = true;
  document.querySelector('#review-lane').hidden = true;
  document.querySelector('.ticket-switcher').hidden = true;
  for (const control of document.querySelectorAll('.actions > button, .mode-switch')) control.hidden = true;
  document.querySelector('#document-name').textContent = `${data.relativePath} · английский оригинал`;
  setStatus('Только чтение');
  if (requestedLine > 0) editor.revealLineInCenter(requestedLine);
}
