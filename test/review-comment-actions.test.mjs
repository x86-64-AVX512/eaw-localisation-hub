import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommentActions } from '../apps/review/src/comment-actions.ts';

function setup() {
  const opened=[],events=new Map(),notices=[];let action,enabled,readOnly=false;
  const state={path:'file.yml',ready:true,documentView:'shared',roles:['translator']};
  const button={disabled:false,hidden:false,addEventListener:(k,v)=>events.set(k,v),removeEventListener:k=>events.delete(k)};
  const editor={getModel:()=>({}),getOption:()=>readOnly,createContextKey:()=>({set:v=>enabled=v,reset(){}}),
    addAction:v=>(action=v,{dispose(){}}),onDidChangeConfiguration:()=>({dispose(){}}),onDidChangeModel:()=>({dispose(){}}),onMouseDown:()=>({dispose(){}})};
  const options={monaco:{editor:{EditorOption:{readOnly:1}}},editor,button,state,selectionBytes:()=>({start:4,end:12}),
    anchor:m=>({...m,reviewAnchors:'captured'}),openDraft:m=>opened.push(m),showToast:m=>notices.push(m)};
  return {options,opened,events,notices,state,button,get action(){return action;},get enabled(){return enabled;},setReadOnly:v=>readOnly=v};
}
test('toolbar and menu capture the original anchored selection and open an inline draft without sending',()=>{
  const s=setup(),controller=createCommentActions(s.options);
  assert.equal(s.action.label,'Создать комментарий');assert.equal(s.enabled,true);
  controller.create();s.options.selectionBytes=()=>({start:80,end:90});
  assert.deepEqual(s.opened[0],{type:'commentCreate',path:'file.yml',startByte:4,endByte:12,reviewAnchors:'captured'});
  s.events.get('click')();assert.equal(s.opened.length,2);
  controller.dispose();assert.equal(s.events.has('click'),false);
});
test('comment command refuses disconnected, hidden, disabled and nonshared documents',()=>{
  for(const block of [s=>s.state.ready=false,s=>s.state.documentView='mine',s=>s.button.hidden=true,s=>s.button.disabled=true,s=>s.setReadOnly(true)]){
    const s=setup();block(s);const controller=createCommentActions(s.options);controller.create();assert.equal(s.enabled,false);assert.equal(s.opened.length,0);
  }
});
test('contributors can draft comments on a Russian file even though the text editor is readonly',()=>{
  const s=setup();s.state.roles=['mod-contributor'];s.state.relativePath='localisation/russian/file.yml';s.setReadOnly(true);
  createCommentActions(s.options).create();assert.equal(s.opened.length,1);
});
