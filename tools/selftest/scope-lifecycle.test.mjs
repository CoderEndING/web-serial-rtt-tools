import assert from 'node:assert/strict';
import {ScopeView} from '../../app/scope/view.js';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
globalThis.document={getElementById:()=>({value:'0'})};
for(const fail of [false,true]){
 const cfg=gate(),v=Object.create(ScopeView.prototype),events=[];let calls=0;
 Object.assign(v,{selected:[{addr:0x20000000,scalar:'u32',name:'x',size:4}],usingMock:true,hid:{},running:false,transport:{running:false,start:async function(){calls++;this.running=true;},stop:async function(){events.push('USB-stop');this.running=false;}},renderer:{setStore(){},setTrigger(){},clearMarks(){}},periodUs:()=>100,seconds:()=>1,isReal:()=>false,updatePlan:()=>({}),applyTrigger(){},configureScope:()=>cfg.promise,_startWatchdog(){},_stopWatchdog(){},_absorbeStatusBackend(){},benchFresh:()=>false,setStatusText(){},syncButtons(){},hidXfer:async(cmd,data)=>{events.push(data[0]===0?'HID-stop':'HID-start');return Uint8Array.of(0,0,0);}});
 const start=v.start();await v.start();const stop=v.stop('cancel');await tick();cfg.resolve(fail?null:Uint8Array.of(0,0,0));await Promise.all([start,stop]);
 assert.equal(calls,0);assert.equal(v.running,false);assert.equal(v._capturing,false);assert.deepEqual(events,['HID-stop','USB-stop']);assert.equal(v._starting,false);
}
{
 const status=gate(),reached=gate(),v=Object.create(ScopeView.prototype);
 Object.assign(v,{selected:[{addr:0x20000000,scalar:'u32',name:'x',size:4}],usingMock:true,hid:{},running:false,transport:{running:false,start:async function(){this.running=true;},stop:async function(){this.running=false;}},renderer:{setStore(){},setTrigger(){},clearMarks(){}},periodUs:()=>100,seconds:()=>1,isReal:()=>false,updatePlan:()=>({}),applyTrigger(){},configureScope:async()=>Uint8Array.of(0,0,0),_startWatchdog(){},_stopWatchdog(){},_absorbeStatusBackend(){},benchFresh:()=>false,setStatusText(){},syncButtons(){},hidXfer:async(cmd,data)=>{if(data[0]===2){reached.resolve();return status.promise;}return Uint8Array.of(0,0,0);}});
 const start=v.start();await reached.promise;const stop=v.stop();status.resolve(Uint8Array.of(0,0,0));await Promise.all([start,stop]);
 assert.equal(v.running,false);assert.equal(v.transport.running,false);assert.equal(v._capturing,false);
}
console.log('scope-lifecycle: double start, cancellation during CONFIG/STATUS, STOP before USB drain PASS');
