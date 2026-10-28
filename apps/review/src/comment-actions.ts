import { uiText } from '../../../packages/shared/src/ui-language.mts';
import type * as Monaco from 'monaco-editor';
import { canEditDocument } from '../../../packages/shared/src/document-permissions.mts';
import type { NewCommentDraft } from './discussion-editor.ts';

export function createCommentActions({ monaco, editor, button, state, selectionBytes, openDraft,
  anchor = message => message, showToast }: {
  monaco: typeof Monaco; editor: Monaco.editor.IStandaloneCodeEditor; button: HTMLButtonElement;
  state: {path:string;ready:boolean;documentView:string;roles?:string[];relativePath?:string};
  selectionBytes():{start:number;end:number}; openDraft(request:NewCommentDraft):void;
  anchor(message:{type:string;path:string;startByte:number;endByte:number;[key:string]:unknown}):{path:string;startByte:number;endByte:number;reviewAnchors?:string};
  showToast(text:string,error?:boolean):void;
}) {
  const available = () => Boolean(state.path && state.ready && state.documentView === 'shared'
    && !button.disabled && !button.hidden && (!editor.getOption(monaco.editor.EditorOption.readOnly)
      || !canEditDocument(state,state.relativePath ?? '')));
  const context = editor.createContextKey<boolean>('eawCanCreateComment',false);
  const refresh = () => context.set(available());
  function create() {
    if (!available() || !editor.getModel()) return;
    try {
      const range=selectionBytes();
      openDraft(anchor({type:'commentCreate',path:state.path,startByte:range.start,endByte:range.end}));
    } catch(error) {showToast(error instanceof Error ? error.message : String(error),true);}
  }
  const action=editor.addAction({id:'eaw.review.createComment',label:uiText('Создать комментарий'),
    precondition:'eawCanCreateComment',contextMenuGroupId:'1_modification',contextMenuOrder:3,run:create});
  button.addEventListener('click',create);
  const subscriptions=[editor.onDidChangeConfiguration(refresh),editor.onDidChangeModel(refresh),editor.onMouseDown(refresh)];
  refresh();
  return {create,refresh,dispose(){button.removeEventListener('click',create);for(const item of subscriptions)item.dispose();action.dispose();context.reset();}};
}
