import assert from 'node:assert/strict';
import { FlashView } from '../../app/flash/view.js';
const nodes=new Map(['f-flash','f-path','f-backend','f-bar'].map(id=>[id,{value:id==='f-backend'?'webusb':'',hidden:false}]));
globalThis.document={getElementById:id=>nodes.get(id)||null};
const tick=()=>new Promise(r=>setImmediate(r));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
{
 const prep=gate(),write=gate(),close=gate();let calls=0;
 const v=Object.create(FlashView.prototype);Object.assign(v,{busy:false,file:{name:'fw.bin'},_clearProbeUsers:()=>prep.promise,_status(){},_hbStart(){},_hbStop(){},probe:{disconnect:()=>close.promise},_flashWebusb:async()=>{calls++;await write.promise;}});
 const first=v.flash();await v.flash();assert.equal(v.busy,true);assert.equal(nodes.get('f-flash').disabled,true);
 prep.resolve(true);await tick();assert.equal(calls,1);write.resolve();await tick();await v.flash();assert.equal(calls,1,'closing still owns operation');
 close.resolve();await first;assert.equal(v.busy,false);assert.equal(v.probe,null);assert.equal(nodes.get('f-flash').disabled,false);
}
for(const fail of [false,true]){
 const v=Object.create(FlashView.prototype);Object.assign(v,{busy:false,file:{name:'fw.bin'},_clearProbeUsers:async()=>{if(fail)throw new Error('prep');return false;}});
 if(fail)await assert.rejects(v.flash(),/prep/);else await v.flash();
 assert.equal(v.busy,false);assert.equal(nodes.get('f-flash').disabled,false);
}
console.log('flash-lifecycle: preparation, duplicate click, disconnect ownership, cancellation and errors PASS');
