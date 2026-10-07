import assert from 'node:assert/strict';
import {Elf} from '../../app/elf/elf.js';
import {SymTab} from '../../app/dbg/symbols.js';
import {RiscvDebugSession} from '../../app/dbg/riscv.js';
import {RiscvTransport} from '../../app/flash/hpm/riscv-dm.js';
import {SBCS,DM,DMI_OP,DMI_STATUS,dmiRequest} from '../../app/flash/hpm/jtag.js';

const elf=Object.create(Elf.prototype);
elf.b=Uint8Array.of(11,12,21,22,31,32);
let segments=[{addr:0x80000000,off:0,size:2,type:1,flags:6},
 {addr:0x80000002,off:2,size:2,type:1,flags:2}];
elf.sections=()=>segments;
const sym=Object.create(SymTab.prototype);sym.elf=elf;
const s=Object.create(RiscvDebugSession.prototype),logs=[];
let reads=0,clears=0,failing=false;
Object.assign(s,{sym,halted:true,pc:0x80000000,_frames:{sentinel:true},_log:t=>logs.push(t),dm:{
 async readMem(a,n){reads++;if(failing)throw Error('SBA failed');return new Uint8Array(n).fill(7);},
 async sbaClearErrors(){clears++;},
 async init(){throw Error('implicit DM reset is forbidden');},
 async sbaHealthCheck(){throw Error('implicit target reset is forbidden');}
}});
assert.deepEqual([...await s.memRead(0x80000000,4)],[11,12,21,22]);
assert.equal(reads,0);assert.match(logs[0],/ELF.*未读取目标实时内存/);
assert.deepEqual([...elf.bytesAt(0x80000001,2,{ro:true})],[12,21]);
for(const mutate of [()=>{s.sym=null;},()=>{segments[1].addr++;},()=>{segments[1].flags=3;},()=>{segments[1].off=99;}]){
 const before=structuredClone(segments);mutate();
 await assert.rejects(s.memRead(0x80000000,4),/数据不可用/);
 segments=before;s.sym=sym;
}
assert.equal(reads,0,'missing image bytes never fall back to dangerous SBA');
await assert.rejects(s.memRead(0x7fffffff,2),/数据不可用/);
await assert.rejects(s.memRead(0xffffffff,2),/32 位/);
await assert.rejects(s.memRead(-1,4),/32 位/);
assert.equal(elf.bytesAt(0xffffffff,2),null);
// Only SHF_ALLOC file data may stand in for instruction/RO bytes.
segments[1].flags=0;assert.equal(elf.bytesAt(0x80000000,4,{ro:true}),null);segments[1].flags=2;
assert.equal(sym.covers(0x80000000,4),true);
assert.equal(sym.covers(0x80000000,5),false);
assert.equal(sym.covers(0xffffffff,2),false);
assert.equal(Object.create(SymTab.prototype).covers(0x20000000),false);

// Failed ordinary reads cannot reset or resume the target, or retry the bad bus access.
failing=true;const frames=s._frames;
await assert.rejects(s.memRead(0x01200000,8),/SBA failed/);
assert.equal(reads,1);assert.equal(clears,1);assert.equal(s.halted,true);assert.equal(s._frames,frames);
await assert.rejects(s.memRead(0x01200000,8),/15 秒/);assert.equal(reads,1);
failing=false;assert.equal((await s.memRead(0x01200000,4))[0],7,'cooldown is range-specific');
s._badAddrs.get('18874368:8').at-=15001;
assert.equal((await s.memRead(0x01200000,8))[0],7);
assert.equal(s._badAddrs.has('18874368:8'),false);

// Transport fences the complete aligned span before any hardware command.
const t=Object.create(RiscvTransport.prototype);let touched=0;
t.sbaConfig=async()=>{touched++;throw Error('allowed SBA path');};
for(const [a,n]of [[0x80000000,4],[0x7ffffffc,8],[0x8fffffff,2]]){
 await assert.rejects(t.readMem(a,n),/XIP\/flash/);assert.equal(touched,0);
}
for(const [a,n]of [[0xffffffff,2],[-1,4],[0,1.5],[0,-1]]){
 await assert.rejects(t.readMem(a,n),/32 位/);assert.equal(touched,0);
}
for(const a of [0x01200000,0x7ffffffc,0x90000000])await assert.rejects(t.readMem(a,4),/allowed SBA path/);
assert.equal(touched,3);
console.log('RISC-V memory: adjacent ELF segments, missing/hole/write/nonallocated/truncated bytes rejected, full XIP fence, no implicit reset, bounded range cooldown PASS');

// Unknown/invalid state cannot justify abstract commands or a resume write.
for(const state of [0,0x67adb267,0x40c0a2]){
 const session=Object.create(RiscvDebugSession.prototype);let abstract=0,writes=0;
 Object.assign(session,{halted:true,_log(){},dm:{dmiRead:async()=>state,readReg:async()=>{abstract++;},dmiWrite:async()=>{writes++;}}});
 await assert.rejects(session.run(),/无法确认/);
 await assert.rejects(session._ensureHalted('test'),/无法确认/);
 assert.equal(abstract,0);assert.equal(writes,0);
}
// A register refresh failure retains the prior snapshot rather than fabricating zeros.
const registers=Object.create(RiscvDebugSession.prototype),oldRegs=[{name:'a0',value:123}];
Object.assign(registers,{halted:true,regs:oldRegs,pc:99,_log(){},dm:{dmiRead:async()=>0x4c03a2,readReg:async()=>{throw Error('register read failed');}}});
await assert.rejects(registers.refreshRegs(),/register read failed/);
assert.equal(registers.regs,oldRegs);assert.equal(registers.pc,99);
// A failed breakpoint re-arm must prevent resetRun from resuming without breakpoints.
const reset=Object.create(RiscvDebugSession.prototype);let resumed=false;
Object.assign(reset,{bps:[0x80000000],_log(){},dm:{_haltByReset:async()=>{},dmiRead:async()=>0x4c03a2},
 _programBps:async()=>{throw Error('trigger failed');},run:async()=>{resumed=true;}});
await assert.rejects(reset.resetRun(),/trigger failed/);assert.equal(resumed,false);
const pause=Object.create(RiscvDebugSession.prototype);
Object.assign(pause,{_log(){},_haltQuiet:async()=>{throw Error('halt failed');},_healDm:async()=>true,dm:{halt:async()=>{throw Error('reset fallback must not run');}}});
await assert.rejects(pause._haltWithHeal(),/未自动复位目标/);
console.log('RISC-V state: unknown status fails closed, register failures preserve snapshot, failed trigger re-arm blocks resume, failed pause does not system-reset PASS');

// Reset helpers returning successfully do not substitute for actual hart state.
for(const action of ['resetHalt','resetRun']){
 const session=Object.create(RiscvDebugSession.prototype);let rearmed=false;
 Object.assign(session,{dm:{resetHalt:async()=>{},_haltByReset:async()=>{},dmiRead:async()=>0x4f0ca2},
 _rearmBpsAfterReset:async()=>{rearmed=true;},_log(){}});
 await assert.rejects(session[action](),/停机未确认/);assert.equal(rearmed,false);
}
console.log('RISC-V reset: helper return is not proof of halt; running hart blocks re-arm/resume PASS');

/**
 * 批量 SBA 读的**批内自检**：一批字的 DMI 状态可以全是 SUCCESS，而 DM 因为"上一笔还没完就
 * 收到下一次 sbdata0 访问"置了 `sbbusyerror` —— 那一批数据不可信，而且旧实现会把这个错误
 * 直接抛出去、把那一笔事务留在总线上（用户现场：往监视里加个结构体，从此内存读全废）。
 * 新实现把 `READ sbcs` 拼在**同一条扫描的批尾**（0 条额外 USB 命令），发现错误就清粘滞位、
 * 地址写回对齐、这一段按字重读。这个用例把全过程钉死。
 */
function burstRig({overrunBursts = new Set()} = {}){
  const mem = new Map(), st = {burst:0, cur:0, sbcsErr:false, cleared:0, scans:0, sbcsReads:0};
  const t = Object.create(RiscvTransport.prototype);
  Object.assign(t, {
    _burstOff: false, _burstMiss: 0, _holdAddr: null, lastSbcs: 0, sbaFailed: false,
    _burstWords: () => 4,                       // 小批次：16 字节就是"跨批"了
    async sbaConfig(){},
    async sbaClearErrors(){ st.cleared++; st.sbcsErr = false; },
    async dmiWrite(a, v){
      if (a === DM.SBADDRESS0) st.cur = v >>> 0;                       // 写地址即（重新）对齐自增指针
      if (a === DM.SBCS && (v & (SBCS.SBBUSYERROR | SBCS.SBERROR))) st.sbcsErr = false;
    },
    async dmiRead(a){
      if (a === DM.SBCS){ st.sbcsReads++; return st.sbcsErr ? SBCS.SBBUSYERROR : 0; }
      if (a === DM.SBDATA0){ const w = mem.get(st.cur) ?? 0; st.cur = (st.cur + 4) >>> 0; return w; }
      throw Error('unexpected dmiRead 0x' + (a >>> 0).toString(16));
    },
    async _scanDRMany(reqs){
      st.scans++;
      st.burst++;
      const willOverrun = overrunBursts.has(st.burst);
      const resps = [];
      for (let k = 0; k < reqs.length; k += 2){
        const op = Number(BigInt(reqs[k]) & 0x3n), addr = Number((BigInt(reqs[k]) >> 34n) & 0x7fn);
        let data = 0;
        if (op === DMI_OP.READ && addr === DM.SBDATA0){ data = mem.get(st.cur) ?? 0; st.cur = (st.cur + 4) >>> 0; }
        else if (op === DMI_OP.READ && addr === DM.SBCS) data = willOverrun ? SBCS.SBBUSYERROR : (st.sbcsErr ? SBCS.SBBUSYERROR : 0);
        resps.push(dmiRequest(DMI_OP.NOP, 0, 0), BigInt(DMI_STATUS.SUCCESS) | (BigInt(data) << 2n));
      }
      if (willOverrun) st.sbcsErr = true;        // 批后 DM 留下粘滞错误位，直到有人写 1 清掉
      return resps;
    },
  });
  for (let i = 0; i < 16; i++) mem.set(0x4000b600 + i * 4, 0x1000 + i);
  return {t, st, mem};
}

// ① 正常：一批 16 字节 = 1 次扫描，不碰逐字路径
{
  const {t, st} = burstRig();
  const b = await t.readMem(0x4000b600, 16);
  assert.deepEqual([...b], [0x00,0x10,0,0, 0x01,0x10,0,0, 0x02,0x10,0,0, 0x03,0x10,0,0]);
  assert.equal(st.scans, 1);assert.equal(st.cleared, 0);
}

// ② 第 1 批超速：数据必须靠逐字重读补齐（不能信那批 / 不能抛错 / 粘滞位要清掉）
{
  const {t, st} = burstRig({overrunBursts: new Set([1])});
  const b = await t.readMem(0x4000b600, 16);
  assert.deepEqual([...b], [0x00,0x10,0,0, 0x01,0x10,0,0, 0x02,0x10,0,0, 0x03,0x10,0,0],
    '超速那一批要作废并按字重读，不能让残值混进结果');
  assert.equal(st.cleared, 1, 'sbbusyerror 是写 1 清零的粘滞位，必须清掉');
  assert.equal(st.sbcsErr, false);
  assert.equal(t._burstMiss, 1);
  assert.equal(t._burstOff, false);
}

// ③ 连续 3 批都超速 ⇒ 关掉批量（BURST=4 ⇒ 48 字节正好 3 批）
{
  const {t, st} = burstRig({overrunBursts: new Set([1, 2, 3])});
  const b = await t.readMem(0x4000b600, 48);      // 12 个字 ⇒ 3 批，全部超速
  assert.equal(b.length, 48);
  assert.deepEqual([...b.subarray(0, 4)], [0x00,0x10,0,0]);
  assert.deepEqual([...b.subarray(44, 48)], [0x0b,0x10,0,0], '被作废的每一批都要按字重读补齐');
  assert.ok(st.cleared >= 2, '每一批超速都要各自清一次');
  assert.equal(t._burstMiss, 3);
  assert.equal(t._burstOff, true, '连撞 3 次就整段别再批（正确优先）');
}

// ④ 单独读一次 sbcs 时短暂 sbbusy：先等它落，不许直接判定"卡死"
{
  const t = Object.create(RiscvTransport.prototype);
  let polls = 0;
  Object.assign(t, {lastSbcs:0, sbaFailed:false, dmiRead: async () => (++polls <= 2 ? SBCS.SBBUSY : 0)});
  await t._checkSbcsAt(0x4000b600, 100);          // 不抛
  assert.equal(polls, 3);assert.equal(t.sbaFailed, false);
}
// ⑤ sbbusy 真的不落：明确报错并告诉用户怎么恢复
{
  const t = Object.create(RiscvTransport.prototype);
  Object.assign(t, {lastSbcs:0, sbaFailed:false, dmiRead: async () => SBCS.SBBUSY});
  await assert.rejects(t._checkSbcsAt(0x4000b600, 100), /断开.*重连|断电重上电/);
  assert.equal(t.sbaFailed, true);
}
console.log('RISC-V SBA burst: in-scan sbcs fence, overrun burst discarded and re-read word-wise, sticky error cleared, burst disabled after 3 misses, transient sbbusy tolerated PASS');
