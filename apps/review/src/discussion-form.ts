import { uiText } from '../../../packages/shared/src/ui-language.mts';
import type { DiscussionDraft } from './discussion-drafts.ts';
export function createDiscussionForm(draft: DiscussionDraft, options: {
  input():void; submit():void; cancel(button:HTMLButtonElement):void; jump():void; layout():void; reload?(button:HTMLButtonElement):void;
}) {
  const form = document.createElement('form'); form.className = 'discussion-composer'; form.dataset.draftKey = draft.key;
  const label = document.createElement('label'); label.textContent = draft.kind === 'edit' ? uiText('Редактировать сообщение') : uiText('Черновик комментария');
  const textarea = document.createElement('textarea'); textarea.value = draft.body; textarea.rows = 3; textarea.maxLength = 8192;
  textarea.setAttribute('aria-label', label.textContent); textarea.placeholder = uiText('Напишите комментарий…');
  label.append(textarea);
  const hint = document.createElement('div'); hint.className = 'discussion-hint';
  const error = document.createElement('div'); error.className = 'discussion-error'; error.setAttribute('role','status');
  const actions = document.createElement('div'); actions.className = 'discussion-actions';
  const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = uiText('К месту в файле'); jump.onclick = options.jump;
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = uiText('Отмена'); cancel.onclick = () => options.cancel(cancel);
  const reload=document.createElement('button');reload.type='button';reload.textContent=uiText('Загрузить актуальный текст');reload.hidden=draft.kind!=='edit';reload.onclick=()=>options.reload?.(reload);
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'primary';
  actions.append(jump,reload,cancel,submit); form.append(label,hint,error,actions);
  textarea.addEventListener('input', () => { draft.body = textarea.value; options.input(); });
  textarea.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!submit.disabled) options.submit(); }
    event.stopPropagation();
  });
  form.addEventListener('submit', event => { event.preventDefault(); options.submit(); });
  form.addEventListener('click', event => event.stopPropagation());
  let previousHeight = 0;
  const observer = new ResizeObserver(entries => {
    const height = entries[0]?.contentRect.height ?? 0;
    if (height !== previousHeight) { previousHeight = height; options.layout(); }
  });
  observer.observe(form);
  return { form, textarea, dispose() { observer.disconnect(); form.remove(); }, update(available:boolean, pending:boolean, detail='') {
    const caption = draft.kind === 'edit' ? uiText('Редактировать сообщение') : uiText('Черновик комментария');
    if (label.firstChild) label.firstChild.textContent = caption;
    textarea.setAttribute('aria-label',caption);
    const bytes = new TextEncoder().encode(draft.body.trim()).length;
    hint.textContent = uiText('Черновик сохраняется на этом компьютере. {0}/2048 байт · Ctrl+Enter – отправить',bytes);
    hint.classList.toggle('error',bytes > 2048);
    error.textContent = detail; error.hidden = !detail;
    textarea.readOnly = pending; cancel.disabled = pending;
    reload.disabled=pending;reload.hidden=draft.kind!=='edit';
    submit.disabled = pending || !available || bytes === 0 || bytes > 2048;
    submit.textContent = pending ? uiText('Отправляется…') : draft.kind === 'edit' ? uiText('Сохранить') : uiText('Отправить');
    if (textarea.value !== draft.body) textarea.value = draft.body;
  } };
}
