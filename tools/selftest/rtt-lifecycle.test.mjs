import assert from 'node:assert/strict';
import {RttView} from '../../app/rtt/view.js';
const gate=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));
const saved=globalThis.setTimeout,timers=[];globalThis.setTimeout=f=>{timers.push(f);return timers.length;};
try{
 for(const error of [false,true]){
  const old=gate(),fresh=gate(),v=Object.create(RttView.prototype),seen=[];
  Object.assign(v,{probe:{fast:false},bridge:null,stats:{},interval:5,_ingest:b=>seen.push(b[0]),rtt:{readUp:()=>old.promise}});
  const startTimers=timers.length;v._startPoll();v.running=false;v.rtt={readUp:()=>fresh.promise};v._startPoll();
  if(error)old.reject(new Error('old disconnected'));else old.resolve({bytes:Uint8Array.of(77),lost:0,high:false,level:0,corrupt:false});await tick();
  assert.deepEqual(seen,[]);assert.equal(v.running,true);assert.equal(timers.length,startTimers,'old loop must not schedule');
  fresh.resolve({bytes:Uint8Array.of(88),lost:0,high:false,level:0,corrupt:false});await tick();assert.deepEqual(seen,[88]);assert.equal(timers.length,startTimers+1);v.running=false;
 }
}finally{globalThis.setTimeout=saved;}
console.log('rtt-lifecycle: stale successful/failed polls cannot publish, stop replacement or schedule old workers PASS');
