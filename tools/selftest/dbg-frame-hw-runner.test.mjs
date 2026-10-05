/** Execute the runner against a deterministic browser/session double; no hardware claims. */
import assert from 'node:assert/strict';
import {FRAME_CASES,webVariables} from './dbg-frame-contract.mjs';
import {runFrameStress} from './dbg-frame-hw-runner.mjs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function rig({wrongValue=false,mutate=false,badFlash=false}={}){
 let checkpoint=0x08001000,bps=0,r0=0,selected=0,panel='',buttons=null;
 const sp=0x20004000;
 const rows=()=>[{name:'test',value:wrongValue?'8':'7',argument:false}];
 const frames=()=>[{pc:checkpoint,lookup:checkpoint,sp,loc:{file:'dbg_frames.c',line:10},regs:Array(16).fill(0),known:[0]}];
 const session={connected:true,halted:true,pc:checkpoint,_frames:null,
  exclusive:async fn=>await fn(),refresh:async()=>{session.halted=true;session.pc=checkpoint;},
  readReg:async name=>name==='SP'||name==='R13'?sp:name==='R15'?session.pc:name==='R0'?r0:0,
  writeReg:async()=>{session._frames=null;},memWrite:async()=>{session._frames=null;},
  memRead:async(a,n)=>new Uint8Array(n).fill(a<0x20000000&&badFlash?1:0),
  cont:async()=>{session.halted=false;session._frames=null;},run:async()=>{session.halted=false;session._frames=null;},
  halt:async()=>{session.halted=true;},bpClear:async()=>{bps=0;}};
 const d={session,srcCur:{},sym:{elf:{b:new Uint8Array()},funcAt:()=>({name:'engine_frame_test'})},
  async runLine(line){
   if(line==='bd all'){bps=0;return {};}
   if(line.startsWith('b ')){checkpoint=Number(line.slice(2));bps=1;return {};}
   if(line.startsWith('bt ')){session._frames={frames:frames()};panel='帧 #0';return {backtrace:session._frames};}
   if(line.startsWith('frame ')){
    if(!session._frames)return {error:'栈帧已失效'};
    selected=Number(line.slice(6));buttons={dataset:{frame:String(selected)}};d.srcCur={file:'dbg_frames.c',line:10};
    if(mutate)r0++;
    return {locals:{rows:rows()}};
   }
   if(line==='s'||line==='c'||line==='reset halt'){session._frames=null;panel='暂停后回溯';return {};}
   throw new Error('unexpected command '+line);
  },
  loadElfBuffer(){session._frames=null;},
  async disconnect(){session._frames=null;session.connected=false;}};
 const window={__tools:{dbg:d},__S:{resetToFirmware:async()=>({pc:checkpoint}),leak:async()=>({used:bps,bps,extra:0})}};
 const document={querySelector:()=>buttons,getElementById:()=>({textContent:panel})};
 const cdp={json:async expr=>await new AsyncFunction('window','document','return ('+expr+');')(window,document),eval:async code=>await new AsyncFunction('window','document',code)(window,document)};
 const oracle={cases:Object.fromEntries(FRAME_CASES.map((c,i)=>[c.id,{pc:0x08001000+i*8,frames:[{name:'engine_frame_test',pc:0x08001000+i*8,sp,variables:webVariables([{name:'test',value:'7',argument:false}])}]}]))};
 const results=[];
 return {cdp,oracle,board:'f103cb',rounds:2,code:[{name:'.text',addr:0x08000000,bytes:[0,0]}],ok:(passed,name,details)=>results.push({passed,name,details}),log:()=>{},results,session};
}
const good=rig();const report=await runFrameStress(good);assert.equal(report.length,7);assert.ok(good.results.every(r=>r.passed),JSON.stringify(good.results));assert.equal(good.session.connected,false);
for(const options of [{wrongValue:true},{mutate:true},{badFlash:true}]){
 const r=rig(options);await runFrameStress(r);assert.ok(r.results.some(v=>!v.passed));assert.equal(r.session.connected,false);
}
console.log('dbg-frame-hw-runner: case/round traversal, UI selection, read-only snapshots, stale-cache flow, target mismatch rejection and disconnect on failure PASS');
