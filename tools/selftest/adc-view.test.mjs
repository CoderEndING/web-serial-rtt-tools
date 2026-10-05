import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AnalogView} from '../../app/analog/view.js';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const ids=[...html.matchAll(/\bid="(an-[^"]+)"/g)].map(m=>m[1]);
assert.equal(new Set(ids).size,ids.length,'ADC/DAC controls must have distinct IDs');
const elements=new Map(ids.map(id=>[id,{value:'',style:{},options:[],addEventListener(){},width:1000,height:260}]));
for(const [,attrs,id] of html.matchAll(/<input\b([^>]*\bid="(an-[^"]+)"[^>]*)>/g))elements.get(id).value=attrs.match(/\bvalue="([^"]*)"/)?.[1]??'';
for(const [,id,body] of html.matchAll(/<select\b[^>]*\bid="(an-[^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
  const options=[...body.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([,a,t])=>({value:a.match(/\bvalue="([^"]*)"/)?.[1]??t,selected:a.includes('selected')}));
  elements.get(id).options=options;elements.get(id).value=(options.find(o=>o.selected)??options[0])?.value??'';
}
elements.get('an-wave').value='sine';
let trace=false,coordinates=[];
const context={fillRect(){},clearRect(){},beginPath(){},stroke(){},setLineDash(){},fillText(){},moveTo(x,y){if(trace)coordinates.push([x,y]);},lineTo(x,y){if(trace)coordinates.push([x,y]);},set strokeStyle(v){trace=v==='#ffd15c';}};
for(const id of ['an-adc-canvas','an-dac-canvas'])elements.get(id).getContext=()=>context;
globalThis.document={getElementById(id){assert.ok(elements.has(id),`missing ${id}`);return elements.get(id);}};
const view=new AnalogView();view.init();assert.equal(view.wave.length,1024);
assert.ok(elements.get('an-dac-start').disabled);
view.store.append({codes:Uint16Array.from({length:10},()=>30000),rate:1000,bits:16});view.total=10;
elements.get('an-time').value='.01';view.renderAdc();
assert.ok(coordinates.length);assert.equal(Math.max(...coordinates.map(p=>p[0])),90,'10 samples at 1kSa/s span 9ms, not an entire 100ms screen');
assert.match(elements.get('an-stats').textContent,/当前时窗超过记录长度/);
coordinates=[];elements.get('an-freeze').checked=true;view.renderAdc();assert.equal(coordinates.length,0);
console.log('ADC page: actual HTML control binding, DAC preview/reservation, partial-record time axis, freeze PASS');
