import { uiText, uiMessage } from '../../../packages/shared/src/ui-language.mts';
import { decodeBase64, encodeBase64 } from './review-utilities.ts';
import { confirmAction } from './confirm-action.ts';
import { createDiscussionForm } from './discussion-form.ts';
import { discussionDraftScope, loadDiscussionDrafts, resumeDraftAsEdit, saveDiscussionDrafts } from './discussion-drafts.ts';
import type { DiscussionDraft } from './discussion-drafts.ts';
import type { ReviewCardMessage } from './review-card-elements.ts';
import type { CardItem } from './review-card-types.ts';
import type { createAppState } from './app-state.ts';
import type * as Monaco from 'monaco-editor';

export interface DiscussionResult { requestId:string; id:string; status:string; revision?:number; message?:string }
export interface NewCommentDraft { path:string; startByte:number; endByte:number; reviewAnchors?:string }
export function createDiscussionEditor({ state, editor, rangeFromBytes, send, refresh, showToast }: {
  state: ReturnType<typeof createAppState>; editor: Monaco.editor.IStandaloneCodeEditor;
  rangeFromBytes(start:number,end:number):Monaco.Range; send(message:{type:string;[key:string]:unknown}):void;
  refresh():void; showToast(text:string,error?:boolean):void;
}) {
  let scope = '', drafts:DiscussionDraft[] = [], storageWarning = false;
  const forms = new Map<string,ReturnType<typeof createDiscussionForm>>();
  const newCards = new Map<string,HTMLElement>();
  const pending = new Map<string,{draft:DiscussionDraft;body:string;timer:ReturnType<typeof setTimeout>}>();
  const errors = new Map<string,string>();
  const available = () => state.ready && state.discussionUpdates && state.documentView === 'shared'
    && !['applied','closed'].includes(state.ticket?.status ?? '');
  function ensureScope() {
    const next = discussionDraftScope(state);
    if (!next || next === scope) return;
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    for (const item of deleteRequests.values()) clearTimeout(item.timer);
    deleteRequests.clear();
    for (const value of forms.values()) value.dispose();
    scope = next; drafts = loadDiscussionDrafts(localStorage, scope); forms.clear(); newCards.clear(); errors.clear();
  }
  function save() {
    try { saveDiscussionDrafts(localStorage,scope,drafts); }
    catch { if (!storageWarning) { storageWarning = true; showToast(uiText('Не удалось сохранить черновик на диск. Не закрывайте это окно.'),true); } }
  }
  function jump(draft:DiscussionDraft) {
    const resolved = draft.reviewAnchors && state.reviewDocument?.resolveAnchors(draft.reviewAnchors);
    const range = rangeFromBytes(resolved ? resolved.startByte : draft.startByte,resolved ? resolved.endByte : draft.endByte);
    editor.revealRangeInCenter(range); editor.setSelection(range); editor.focus();
  }
  function form(draft:DiscussionDraft) {
    let value = forms.get(draft.key);
    if (!value) {
      value = createDiscussionForm(draft, {
        layout: refresh,
        reload: async button => {
          const current=(draft.target==='comment'?state.commentMessages:state.suggestionMessages).get(draft.id)?.find(item=>item.messageId===draft.messageId);
          if (!current) {showToast(uiText('Сообщение больше недоступно. Черновик сохранён.'),true);return;}
          if (!await confirmAction(button,uiText('Заменить ваш черновик актуальным текстом сообщения?'),{label:uiText('Загрузить')}))return;
          draft.body=decodeBase64(current.bodyBase64 ?? '');draft.expectedRevision=current.revision ?? 0;
          delete draft.requestId;delete draft.submittedBody;errors.delete(draft.key);save();updateForms();refresh();
        },
        input: () => { errors.delete(draft.key); if (![...pending.values()].some(item=>item.draft===draft)) delete draft.requestId; save(); updateForms(); refresh(); }, submit: () => submit(draft), jump: () => jump(draft),
        cancel: async button => {
          if (draft.body.trim() && !await confirmAction(button,uiText('Удалить неотправленный черновик?'),{label:uiText('Удалить'),danger:true})) return;
          drafts = drafts.filter(item => item !== draft); forms.get(draft.key)?.dispose(); forms.delete(draft.key); newCards.delete(draft.key); save(); refresh();
        },
      }); forms.set(draft.key,value);
    }
    value.update(available(),[...pending.values()].some(item => item.draft === draft),errors.get(draft.key)
      ?? (!state.ready ? uiText('Нет подключения. Черновик сохранён.') : !state.discussionUpdates ? uiText('Обновите сервер для работы с новыми комментариями.') : ''));
    return value;
  }
  function updateForms() { for (const draft of drafts) form(draft); }
  function open(draft:DiscussionDraft) {
    ensureScope();
    const existing = drafts.find(item => item.key === draft.key);
    if (!existing) { if (drafts.length >= 32) { showToast(uiText('Слишком много черновиков в этом документе.'),true); return; } drafts.push(draft); save(); }
    refresh();
    requestAnimationFrame(() => { const node = form(existing ?? draft); node.form.scrollIntoView({block:'nearest'}); node.textarea.focus(); });
  }
  function submit(draft:DiscussionDraft) {
    if (!available() || [...pending.values()].some(item => item.draft === draft)) return;
    if (draft.kind === 'new' && (!draft.reviewAnchors || !state.reviewDocument?.resolveAnchors(draft.reviewAnchors))) {
      errors.set(draft.key,uiText('Привязка комментария больше недоступна. Скопируйте текст и выберите место ещё раз.')); updateForms(); return;
    }
    const body = draft.body.trim(); if (!body || new TextEncoder().encode(body).length > 2048) return;
    // Stable message/thread IDs make an uncertain retry safe after reconnection.
    draft.requestId ||= crypto.randomUUID(); draft.submittedBody = body; save();
    const requestId=draft.requestId;
    const timer = setTimeout(() => {
      pending.delete(requestId); errors.set(draft.key,uiText('Подтверждение не получено. Черновик сохранён; можно повторить отправку.')); updateForms(); refresh();
    },15000);
    pending.set(draft.requestId,{draft,body,timer}); updateForms();
    send({ type:draft.kind === 'new' ? 'commentCreate' : draft.kind === 'reply'
      ? draft.target === 'comment' ? 'commentReply' : 'suggestionReply' : 'discussionMessageUpdate',
      path:state.path,id:draft.id,messageId:draft.messageId,requestId:draft.requestId,
      ...(draft.kind === 'new' ? {startByte:draft.startByte,endByte:draft.endByte,reviewAnchors:draft.reviewAnchors} : {}),
      ...(draft.kind === 'edit' ? {target:draft.target,expectedRevision:draft.expectedRevision} : {}), bodyBase64:encodeBase64(body) });
  }
  function receive(result:DiscussionResult) {
    ensureScope();
    const flight = pending.get(result.requestId);
    const draft = flight?.draft ?? drafts.find(item => item.requestId === result.requestId);
    if (flight) { clearTimeout(flight.timer); pending.delete(result.requestId); }
    if (!draft || !drafts.includes(draft)) return;
    if (result.status === 'saved' && draft.body.trim() === (flight?.body ?? draft.submittedBody)) {
      drafts = drafts.filter(item => item !== draft); forms.get(draft.key)?.dispose(); forms.delete(draft.key); newCards.delete(draft.key); save(); refresh(); return;
    }
    if (resumeDraftAsEdit(draft,result)) {
      newCards.delete(draft.key);
      if (result.status === 'stale') errors.set(draft.key,uiText('Сообщение уже опубликовано с прежним текстом. Нажмите «Сохранить», чтобы заменить его черновиком.'));
    } else errors.set(draft.key,result.status === 'stale' ? uiText('Сообщение уже изменено. Ваш черновик сохранён. Загрузите актуальный текст перед сохранением.')
      : result.status === 'deleted' ? uiText('Сообщение или обсуждение удалено. Ваш черновик сохранён.') : uiMessage(result.message || uiText('Не удалось отправить сообщение. Черновик сохранён.')));
    save(); updateForms(); refresh();
  }
  function reply(item:CardItem) { open({key:`reply:${item.kind}:${item.id}`,kind:'reply',target:item.kind,id:item.id,
    messageId:crypto.randomUUID(),body:'',expectedRevision:0,startByte:item.startByte,endByte:item.endByte}); }
  function edit(item:CardItem,message:ReviewCardMessage) { open({key:`edit:${item.kind}:${item.id}:${message.messageId}`,kind:'edit',target:item.kind,
    id:item.id,messageId:message.messageId!,body:decodeBase64(message.bodyBase64 ?? ''),expectedRevision:message.revision ?? 0,startByte:item.startByte,endByte:item.endByte}); }
  function enhance(card:HTMLElement,item:CardItem,messages:ReviewCardMessage[] | undefined) {
    const rows = [...card.querySelectorAll<HTMLElement>('.thread-message')];
    messages?.forEach((message,index) => {
      const row = rows[index]; if (!row || !message.messageId || !state.discussionUpdates) return;
      row.dataset.messageId = message.messageId;
      const own = Boolean(message.authorId && message.authorId === state.userId);
      const moderator = state.roles.some(role => ['admin','senior translator'].includes(role));
      const actions = document.createElement('span'); actions.className = 'message-actions';
      const button = (label:string,action:(button:HTMLButtonElement)=>void) => { const node=document.createElement('button');node.type='button';node.textContent=label;node.onclick=()=>action(node);actions.append(node); };
      if (own) button(uiText('Редактировать'),() => edit(item,message));
      if ((own || moderator) && (item.kind !== 'comment' || index > 0)) button(uiText('Удалить ответ'),async node => {
        if (!available() || !await confirmAction(node,uiText('Удалить этот ответ?'),{label:uiText('Удалить'),danger:true})) return;
        node.disabled = true;
        const requestId = crypto.randomUUID();
        const timer = setTimeout(()=>{node.disabled=false;deleteRequests.delete(requestId);showToast(uiText('Подтверждение удаления не получено. Проверьте обсуждение.'),true);},15000);
        deleteRequests.set(requestId,{node,timer});
        send({type:'discussionMessageDelete',path:state.path,id:item.id,target:item.kind,messageId:message.messageId,
          requestId,expectedRevision:message.revision ?? 0});
      });
      if (message.editedAt) { const mark=document.createElement('span');mark.className='message-edited';mark.textContent=uiText('изменено');mark.title=message.editedAt;row.querySelector('.message-meta')?.append(mark); }
      row.append(actions);
    });
  }
  const deleteRequests = new Map<string,{node:HTMLButtonElement;timer:ReturnType<typeof setTimeout>}>();
  function mount(card:HTMLElement,item:CardItem) {
    ensureScope();
    for (const node of card.querySelectorAll<HTMLElement>('.discussion-composer')) {
      if (!drafts.some(draft => draft.key === node.dataset.draftKey)) node.remove();
    }
    for (const draft of drafts.filter(draft => draft.kind !== 'new' && draft.id === item.id && draft.target === item.kind)) {
      const host = draft.kind === 'edit' ? [...card.querySelectorAll<HTMLElement>('.thread-message')].find(row=>row.dataset.messageId===draft.messageId) : card;
      if (!host) continue;
      const node = form(draft).form; if (node.parentElement !== host) host.append(node);
    }
  }
  return {
    reply, enhance, mount,
    hasDraftFor(kind:CardItem['kind'],id:string) {ensureScope();return drafts.some(draft=>draft.kind!=='new'&&draft.target===kind&&draft.id===id);},
    create(request:NewCommentDraft) {
      ensureScope(); const existing = drafts.find(draft => draft.kind === 'new' && draft.reviewAnchors === request.reviewAnchors
        && draft.startByte === request.startByte && draft.endByte === request.endByte);
      const id = crypto.randomUUID(); open(existing ?? {key:`new:${id}`,kind:'new',target:'comment',id,messageId:crypto.randomUUID(),
        body:'',expectedRevision:0,startByte:request.startByte,endByte:request.endByte,reviewAnchors:request.reviewAnchors});
    },
    receive(result:DiscussionResult) {
      const deletion = deleteRequests.get(result.requestId);
      if (deletion) { clearTimeout(deletion.timer);deleteRequests.delete(result.requestId);deletion.node.disabled=false;
        if (result.status !== 'saved') showToast(uiMessage(result.message || uiText('Ответ не удалён. Обновите обсуждение и повторите действие.')),true); return; }
      receive(result);
    },
    newCards() {
      ensureScope(); updateForms();
      return drafts.filter(draft => draft.kind === 'new'
        || !(draft.target === 'comment' ? state.comments : state.suggestions).has(draft.id)
        || (draft.kind === 'edit' && !(draft.target === 'comment' ? state.commentMessages : state.suggestionMessages)
          .get(draft.id)?.some(message => message.messageId === draft.messageId))).map(draft => {
        let card=newCards.get(draft.key);
        if (!card) {card=document.createElement('article');card.className='review-card comment-draft-card';card.style.setProperty('--author-color',state.color);
          const head=document.createElement('strong');head.textContent=uiText('Неотправленный комментарий');card.append(head);newCards.set(draft.key,card);}
        const resolved = draft.reviewAnchors && state.reviewDocument?.resolveAnchors(draft.reviewAnchors);
        card.dataset.startByte=String(resolved ? resolved.startByte : draft.startByte);
        card.dataset.itemKey=draft.key; const node=form(draft).form;if(node.parentElement!==card)card.append(node);return card;
      });
    },
    preserveFocus() {
      const active=document.activeElement; if (!(active instanceof HTMLTextAreaElement) || !active.closest('.discussion-composer')) return () => {};
      const start=active.selectionStart,end=active.selectionEnd,scroll=active.scrollTop;
      return () => {if(active.isConnected && document.activeElement!==active){active.focus({preventScroll:true});active.setSelectionRange(start,end);active.scrollTop=scroll;}};
    },
    hasDraft() {ensureScope();return drafts.length>0 || pending.size>0;},
    refresh() {ensureScope();updateForms();},
    dispose() {for(const item of pending.values())clearTimeout(item.timer);for(const item of deleteRequests.values())clearTimeout(item.timer);for(const value of forms.values())value.dispose();save();},
  };
}
