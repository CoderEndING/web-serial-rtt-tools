import assert from 'node:assert/strict';
import {AnalogSession} from '../../app/analog/session.js';
import {AdcTransport} from '../../app/analog/transport.js';
function reply(action,payload=[],rc=0){return Uint8Array.of(8+payload.length,0x38,action,rc,0,0,0,...payload);}
function caps(){const b=new Uint8Array(20),v=new DataView(b.buffer);b.set([65,68,66,50,0x8b,2,15,6]);v.setUint32(8,2000000,true);v.setUint16(12,4096,true);v.setUint16(14,4096,true);b[17]=1;v.setUint16(18,3300,true);return b;}
function rig({lostOpen=false,continuous=false,stopFailure=false,pipeline=false}={}){
 const s=new AnalogSession(),frames=[],readers=[],actions=[];let count=0,owned=false,endSent=false,seq=0,index=0,closed=0;
 let depth=1;
 const push=(done=false)=>{const n=done?0:3,b=new Uint8Array(32+n*2),v=new DataView(b.buffer);b.set([65,68,83,50,2,done?2:1,16,0]);v.setUint32(8,1,true);v.setUint32(12,seq++,true);v.setUint32(16,index,true);v.setUint32(20,1000,true);v.setUint16(24,n,true);b[26]=6;b[27]=2;index+=n;
   const r={status:'ok',data:new DataView(b.buffer)};if(readers.length)readers.shift()(r);else frames.push(r);};
 s.caps={maxRate:2000000};s.transport=new AdcTransport({vendorId:1,productId:2,transferIn(){return frames.length?Promise.resolve(frames.shift()):new Promise(resolve=>readers.push(resolve));}});
 s.hid={connected:true,async xfer(cmd,b){assert.equal(cmd,0x38);const a=b[0];actions.push(a);
  if(a===9)return reply(a,caps());
  if(a===15)return pipeline?reply(a,[1,32]):reply(a,[],1);
  if(a===10){owned=true;depth=b.length===11?b[10]:1;count=new DataView(b.buffer,b.byteOffset).getUint32(6,true);if(lostOpen)throw Error('OPEN response lost');return reply(a,[1,0,0,0]);}
  if(a===13){assert.equal(readers.length,depth,'all native readers before timer start');push();if(!continuous&&count){for(let i=0;i<depth;i++)push(true);endSent=true;}return reply(a);}
  if(a===11){if(stopFailure){stopFailure=false;throw Error('STOP response lost');}if(!endSent){for(let i=0;i<depth;i++)push(true);endSent=true;}return reply(a);}
  if(a===12){if(closed++<2)return reply(a,[],2);owned=false;return reply(a);}
  if(a===14){const p=new Uint8Array(24);p[0]=1;p[20]=+owned;return reply(a,p);}
  throw Error(`unexpected ${a}`);
 }};
 return {s,actions,get owned(){return owned;},get readers(){return readers.length;}};
}
let r=rig(),blocks=[];await r.s.acquire({bits:16,rate:1000,count:3},b=>blocks.push(b));
assert.equal(blocks.length,1);assert.equal(r.s.busy,false);assert.equal(r.owned,false);assert.equal(r.readers,0);assert.deepEqual(r.actions.slice(0,4),[9,15,10,13]);
r=rig({lostOpen:true});await assert.rejects(r.s.acquire({bits:16,rate:1000,count:3}),/OPEN response lost/);assert.equal(r.s.busy,false);assert.equal(r.owned,false);assert.ok(r.actions.includes(14));
r=rig({continuous:true});const run=r.s.acquire({bits:16,rate:1000,count:0});await new Promise(resolve=>setTimeout(resolve,0));await r.s.stopAdc();await run;assert.equal(r.s.busy,false);assert.equal(r.readers,0);
r=rig({continuous:true,stopFailure:true});const active=r.s.acquire({bits:16,rate:1000,count:0});await new Promise(resolve=>setTimeout(resolve,0));await assert.rejects(r.s.stopAdc(),/STOP response lost/);assert.equal(r.s.busy,true);await r.s.stopAdc();await active.catch(()=>{});assert.equal(r.s.busy,false);
console.log('ADC session: USB reader before START, finite/continuous stop, lost OPEN recovery, deferred CLOSE, failed STOP ownership/retry PASS');
for(const options of [{},{continuous:true},{lostOpen:true}]){
 r=rig({...options,pipeline:true});
 const run=r.s.acquire({bits:16,rate:1000,count:options.continuous?0:3});
 if(options.continuous){await new Promise(resolve=>setTimeout(resolve,0));await r.s.stopAdc();}
 if(options.lostOpen)await assert.rejects(run,/OPEN response lost/);else await run;
 assert.equal(r.readers,0);assert.equal(r.s.busy,false);assert.equal(r.owned,false);
 assert.equal(r.s.transport.inFlight,32);
}
console.log('ADC counted END: 32 native readers, finite/STOP/lost OPEN retire without orphan reads PASS');
// ADC STOP must never unlock a DAC task on this shared session.
const dacBusy=new AnalogSession();dacBusy.dac={owned:true};dacBusy.busy=true;
await assert.rejects(dacBusy.stopAdc(),/DAC/);assert.equal(dacBusy.busy,true);
// Native SPI OUT cleanup is part of ownership even before ADC OPEN.
const beforeOpen=new AnalogSession();let finishOut;
beforeOpen.transport={flush:new Promise(resolve=>finishOut=resolve)};beforeOpen.busy=true;
let cleanupDone=false;const cleanup=beforeOpen._cleanupAdc().then(()=>cleanupDone=true);
await Promise.resolve();assert.equal(cleanupDone,false);finishOut();await cleanup;
console.log('ADC ownership: DAC cannot be unlocked by ADC STOP; native SPI OUT drains before cleanup PASS');
