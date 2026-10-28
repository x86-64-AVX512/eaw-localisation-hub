import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeyReplacementPanel, keyReplacementConfirmation } from '../apps/review/src/key-replacement-panel.ts';

class Element {
  children=[]; events=new Map(); disabled=false; hidden=false; value=''; _text='';
  addEventListener(name, handler){this.events.set(name,handler);}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this._text='';this.children=children;}
  set textContent(value){this._text=value;this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  showModal(){this.open=true;}
  close(){this.open=false;}
  focus(){}
}
function fixture(t){
  const names=['open','dialog','input','language','mode','mode-hint','preview','apply','results','close'];
  const controls=Object.fromEntries(names.map(name=>[name,new Element()]));
  const original=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{
    querySelector:selector=>controls[selector.replace('#key-replace-','')],createElement:()=>new Element(),
  }});
  t.after(()=>original?Object.defineProperty(globalThis,'document',original):delete globalThis.document);
  const pending=[],calls=[];
  t.mock.method(globalThis,'fetch',async(route,options)=>{
    calls.push({route,body:JSON.parse(options.body)});
    return new Promise(resolve=>pending.push(data=>resolve({ok:true,json:async()=>data})));
  });
  controls.mode.value='classic';controls.language.value='russian';controls.input.value='key: "Текст"';
  createKeyReplacementPanel({token:'fixture',state:{ticket:null},showToast(){}});
  return {controls,calls,pending};
}
const preview={errors:[],duplicateKeys:[],missingKeys:[],duplicateMatches:[],changes:[{key:'key',file:'a.yml',oldText:'old',newText:'new'}],files:[{path:'a.yml',hash:'abc'}]};

for(const change of ['mode','language','input'])test(`a late preview cannot re-enable apply after changing ${change}`,async t=>{
  const s=fixture(t),c=s.controls;
  c.open.events.get('click')();
  const waiting=c.preview.events.get('click')();
  c[change].value=change==='mode'?'language-filtered':change==='language'?'english':'changed: "Другой текст"';
  c[change].events.get(change==='input'?'input':'change')();
  s.pending.shift()(preview);await waiting;
  assert.equal(c.apply.disabled,true);
  assert.equal(c.results.textContent.includes('old'),false);
  assert.equal(s.calls[0].body.mode,'classic');
});

test('experimental selection is sent to preview and skipped records remain visible',async t=>{
  const s=fixture(t),c=s.controls;
  c.open.events.get('click')();c.mode.value='language-filtered';c.mode.events.get('change')();
  assert.equal(c['mode-hint'].hidden,false);
  const waiting=c.preview.events.get('click')();
  s.pending.shift()({...preview,ignoredEntries:[{key:'foreign',line:3,reason:'language',cyrillicPercent:0,latinPercent:100}],ignoredComments:2});
  await waiting;
  assert.equal(s.calls[0].body.mode,'language-filtered');assert.equal(c.apply.disabled,false);
  assert.match(c.results.textContent,/foreign/u);assert.match(c.results.textContent,/100%/u);
  c.mode.value='classic';c.mode.events.get('change')();assert.equal(c['mode-hint'].hidden,true);assert.equal(c.apply.disabled,true);
});

test('experimental confirmation includes skipped and empty counts while keeping classic wording', () => {
  const data={...preview,ignoredEntries:[{key:'foreign'}],changes:[
    {...preview.changes[0],newText:''},{...preview.changes[0],newText:'  '},
    {...preview.changes[0],newText:'$COUNTRY$'},
  ]};
  assert.equal(keyReplacementConfirmation(data,'classic'),'Применить 3 замен в 1 файлах?');
  assert.equal(keyReplacementConfirmation(data,'language-filtered'),
    'Применить 3 замен в 1 файлах? Пропущено значений: 1. Пустых значений: 2.');
});

test('repository ambiguity shows the file, key and source line and keeps apply disabled',async t=>{
  const s=fixture(t),c=s.controls;
  c.open.events.get('click')();const waiting=c.preview.events.get('click')();
  s.pending.shift()({...preview,changes:[],files:[],errors:[{file:'localisation/russian/a.yml',key:'K',line:42,message:'Неоднозначные кавычки'}]});
  await waiting;
  assert.equal(c.apply.disabled,true);
  for(const value of ['localisation/russian/a.yml','K','42','Неоднозначные кавычки'])assert.ok(c.results.textContent.includes(value),c.results.textContent);
});
