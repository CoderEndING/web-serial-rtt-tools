/** DOM substitutes verify handlers/rendering; not a browser layout or hardware test. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DbgView } from '../../app/dbg/view.js';
import { completeLine } from '../../app/dbg/complete.js';
class Node {
  children=[]; handlers={}; disabled=false;
  set textContent(v){this.text=String(v);this.children=[];}
  get textContent(){return this.text||'';}
  append(...nodes){this.children.push(...nodes);}
  addEventListener(event,fn){this.handlers[event]=fn;}
}
const nodes=new Map(['d-bt-list','d-bt-status','d-wp-list','d-bt','d-bt-scan','d-wp-add','d-wp-clear','d-state'].map(id=>[id,new Node()]));
globalThis.document={getElementById:id=>nodes.get(id)||null,createElement:()=>new Node()};
const view=Object.create(DbgView.prototype), commands=[], sources=[];
view.session={connected:true,halted:true,pc:0x08001000,dwt:{items:[{slot:2,addr:0x20000000,size:4,mode:'w'}]}};
view.runLine=line=>commands.push(line);view.showSource=(file,line)=>sources.push([file,line]);
view.renderDwt();
assert.match(nodes.get('d-wp-list').children[0].children[0].textContent,/#3/);
nodes.get('d-wp-list').children[0].children[1].handlers.click();assert.deepEqual(commands,['wpd 3']);
view.presentBacktrace({frames:[{name:'<img onerror=bad>',pc:0x08001000,sp:0x20000000,kind:'ehabi',loc:{file:'main.c',line:23}}],reason:'CANTUNWIND'});
const frame=nodes.get('d-bt-list').children[0].children[0];
assert.match(frame.textContent,/<img/);assert.equal(frame.disabled,false);
frame.handlers.click();assert.deepEqual(sources,[['main.c',23]]);
view._syncButtons();assert.equal(nodes.get('d-bt').disabled,false);
view.session.halted=false;view._syncButtons();
assert.equal(nodes.get('d-bt').disabled,true);assert.equal(view._btSnapshotValid,false);
assert.match(nodes.get('d-bt-list').textContent,/重新回溯/);
view.session.connected=false;view._syncButtons();assert.equal(nodes.get('d-wp-add').disabled,true);
assert.equal(completeLine('wp variable rw').value,'wp variable rw');
assert.equal(completeLine('wp variable w 6').value,'wp variable w 64');
assert.equal(completeLine('wpd #3',{wps:[{slot:2}]}).value,'wpd #3');
assert.equal(completeLine('bt s').value,'bt scan');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
for(const id of ['d-wp-addr','d-wp-mode','d-wp-size','d-wp-add','d-wp-clear','d-wp-list','d-bt','d-bt-scan','d-bt-list','d-bt-status',
  'd-svd-default','d-svd-pick','d-svd-file','d-svd-periph','d-svd-reg','d-svd-read','d-svd-reg-info','d-svd-value','d-svd-fields'])
  assert.equal(html.split('id="'+id+'"').length-1,1,id+' appears once');
console.log('dbg-watch-bt-ui: stable watch IDs, frame source navigation, safe text, stale state, button states, completions, HTML IDs PASS');
