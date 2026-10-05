/** Hardware runner used by the existing stress entry point. No retries hide mismatches. */
import {FRAME_CASES,webVariables,compareFrames} from './dbg-frame-contract.mjs';
async function captureCheckpoint(address,ramEnd){
 const d=window.__tools.dbg,s=d.session;
 const cmd=async line=>{const r=await d.runLine(line);if(r.error||r.cancelled)throw new Error(line+': '+(r.error||'cancelled'));return r;};
 await cmd('bd all');await cmd('b 0x'+address.toString(16));
 await s.exclusive(async()=>{
  await s.cont();const end=Date.now()+8000;
  do{await new Promise(r=>setTimeout(r,20));await s.refresh();if(s.halted)break;}while(Date.now()<end);
  if(!s.halted)throw new Error('检查点暂停超时');
 });
 if((s.pc&0xfffffffe)!==address)throw new Error('暂停 PC 不等于检查点');
 const snapshot=()=>s.exclusive(async()=>{
  const registers=[];for(let i=0;i<16;i++)registers.push(await s.readReg('R'+i));
  for(const name of ['MSP','PSP','XPSR','CONTROL','PRIMASK','BASEPRI','FAULTMASK'])registers.push(await s.readReg(name));
  const sp=registers[13],length=Math.min(512,ramEnd-sp);
  if(sp<0x20000000||length<4)throw new Error('暂停栈不在测试板 RAM 范围');
  return {registers,stack:[...await s.memRead(sp,length)]};
 });
 const before=await snapshot(),bt=await cmd('bt 16'),frames=[];
 for(let i=0;i<bt.backtrace.frames.length;i++){
  const frame=bt.backtrace.frames[i],name=d.sym.funcAt(frame.lookup)?.name||'';
  if(!name.startsWith('engine_frame_'))break;
  const selected=await cmd('frame '+i);
  frames.push({name,pc:frame.pc,sp:frame.sp,rows:selected.locals.rows});
  const pressed=document.querySelector('#d-bt-list button[aria-pressed="true"]');
  if(pressed?.dataset.frame!==String(i))throw new Error('帧选中 UI 与会话不一致');
  if(frame.loc&&d.srcCur?.file!==frame.loc.file)throw new Error('帧切换后源码文件不匹配');
  if(frame.loc&&d.srcCur?.line!==frame.loc.line)throw new Error('帧切换后源码行不匹配');
 }
 for(let i=frames.length-1;i>=0;i--)await cmd('frame '+i);
 const after=await snapshot();
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('只读回溯/切帧修改了寄存器或栈');
 const leak=await window.__S.leak();
 if(leak.used!==1||leak.bps!==1||leak.extra!==0)throw new Error('栈帧压力期间硬件断点泄漏');
 return {pc:s.pc,frames,reason:bt.backtrace.reason,leak};
}
async function staleChecks(){
 const d=window.__tools.dbg,s=d.session,failures=[];
 const bt=async()=>{const r=await d.runLine('bt 16');if(r.error)throw new Error(r.error);};
 // Same-PC same-value writes must invalidate caches, without altering test inputs.
 await bt();await s.exclusive(async()=>s.writeReg('R0',await s.readReg('R0')));
 if(s._frames)failures.push('写寄存器未清缓存');
 await bt();await s.exclusive(async()=>{const sp=await s.readReg('SP');await s.memWrite(sp,await s.memRead(sp,4));});
 if(s._frames)failures.push('写内存未清缓存');
 await bt();const step=await d.runLine('s');if(step.error)throw new Error(step.error);
 if(s._frames)failures.push('单步未清缓存');
 const stale=await d.runLine('frame 1');if(!stale.error)failures.push('旧帧仍可选择');
 await bt();const continued=await d.runLine('c');if(continued.error)throw new Error(continued.error);
 if(s._frames)failures.push('继续未清缓存');
 await s.exclusive(async()=>s.halt());
 if(document.getElementById('d-locals')?.textContent.includes('帧 #'))failures.push('旧变量仍留在面板');
 await bt();const previous=d.sym;d.loadElfBuffer(previous.elf.b,'same ELF reload');
 if(s._frames)failures.push('重载 ELF 未清缓存');
 await bt();const reset=await d.runLine('reset halt');if(reset.error)throw new Error(reset.error);
 if(s._frames)failures.push('复位未清缓存');
 await bt();await d.disconnect();if(s._frames)failures.push('断开未清缓存');
 return failures;
}
export async function runFrameStress({cdp,oracle,board,rounds=200,code,ok,log}){
 const ramEnd=board==='h743'?0x20020000:board==='f103cb'?0x20005000:0x20010000;
 const results=[];
 try{
  if(!code?.some(s=>s.name==='.text'))throw new Error('缺少目标代码验证');
  for(const section of code){
   for(let offset=0;offset<section.bytes.length;offset+=1024){
    const expected=section.bytes.slice(offset,offset+1024),address=section.addr+offset;
    const actual=await cdp.json(`window.__tools.dbg.session.exclusive(async()=>[...await window.__tools.dbg.session.memRead(${address},${expected.length})])`);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('板上代码与 ELF 不同: '+section.name+'+'+offset);
   }
  }
  ok(true,'Web 独立核对板上 Flash 与当前 ELF 一致');
  // Establish the same first visit to each checkpoint as the GDB collector.
  const reset=await cdp.json(`window.__S.resetToFirmware(${board==='f103ze'})`);
  if(reset.error)throw new Error(reset.error);
  for(const c of FRAME_CASES){
   const expected=oracle.cases[c.id],start=Date.now();
   const captured=await cdp.json(`(${captureCheckpoint.toString()})(${expected.pc},${ramEnd})`);
   const actual=captured.frames.map(f=>({...f,variables:webVariables(f.rows)}));
   const differences=compareFrames(actual,expected.frames);
   ok(differences.length===0,`GDB 对照 ${c.id}: ${actual.length} 帧，逐帧参数/局部值`,differences.join('；'));
   results.push({id:c.id,elapsedMs:Date.now()-start,frames:actual,differences});
  }
  const c=oracle.cases.recursive;
  for(let i=0;i<rounds;i++){
   const captured=await cdp.json(`(${captureCheckpoint.toString()})(${c.pc},${ramEnd})`);
   const actual=captured.frames.map(f=>({...f,variables:webVariables(f.rows)})),diff=compareFrames(actual,c.frames);
   if(diff.length)throw new Error(`压力轮${i+1}: `+diff.join('；'));
   if((i+1)%20===0)log(`   栈帧压力 ${i+1}/${rounds}，无变量差异/寄存器或栈修改/比较器泄漏`);
  }
  ok(true,`${rounds} 轮递归栈回溯、正反切帧及 GDB 对照`);
  const stale=await cdp.json(`(${staleChecks.toString()})()`);
  ok(!stale.length,'写操作/单步/继续/重载 ELF/复位/断开清除旧帧和局部值',stale.join('；'));
 }catch(error){ok(false,'栈帧/局部变量硬件压力流程',error.message);results.push({error:error.message});}
 finally{
  await cdp.eval(`const d=window.__tools.dbg;if(d.session.connected){await d.session.exclusive(async()=>{await d.session.halt();await d.session.bpClear();});await d.disconnect();}return true;`).catch(e=>ok(false,'压力测试收尾',e.message));
 }
 return results;
}
