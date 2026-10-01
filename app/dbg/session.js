/**
 * 调试会话：把 CMSIS-DAP 探针包装成"一个简单调试器该有的动作"（**不碰 DOM**）。
 *
 * 底座全部是已有的东西（`app/rtt/dap-webusb.js` 的 WebUsbDapProbe）：
 *   halt/run/isHalted/_dhcsr、regRead/regWrite（DCRSR/DCRDR）、readMem/writeMem。
 * 这一层新增的只有三样：
 *   ① **硬件断点**（FPB，见 app/dbg/bp.js）—— 网页侧原来没有；
 *   ② **单步**与"跨过断点继续"（C_STEP + C_MASKINTS，命中后必须先摘比较器再单步）；
 *   ③ **抢占纪律**：连之前先请别的页签让出探针、停掉探针侧 RTT 桥（它每毫秒轮询目标内存，
 *      和寄存器访问抢同一条 SWD，实测会把每一步拖慢十倍）。
 *
 * 🚨 三条本项目踩过的硬约束（照做，别改）：
 *   1) **PPB（0xE0000000 那一片）要 ≤1 MHz**：DHCSR/DCRSR/FPB 都在这片，
 *      高时钟下读回 0（本仓烧录/身份识别早就是 1 MHz）。所以时钟默认 1000 kHz，别"顺手调高"。
 *   2) **写 DP CTRL/STAT 只写上电位，绝不"先掉电再上电"**（见 dap-webusb.js 的整段说明）。
 *   3) **WebUSB 没有取消接口**：任何一步超时都会留下挂起传输 —— 超时即把设备标脏，
 *      由 dap-webusb 在 disconnect 时做端口复位。所以这里所有等待都带超时。
 */

import { WebUsbDapProbe, withTimeout } from '../rtt/dap-webusb.js';
import { closeProbeUsbDevices } from '../core/probe-bus.js';
import { waitMs, sleep } from '../core/pace.js';
import { CFBP_SEL, CORE_REGS, SPECIAL_REGS, cfbpGet, cfbpSet, isCfbpSub, regInfo } from './regs.js';
import { FPB, FP_CTRL_KEY, canBreak, compAddr, decodeFpCtrl, planComparators } from './bp.js';
import { u32leBytes } from './fmt.js';

// Cortex-M 的调试寄存器（PPB）
const DHCSR = 0xe000edf0, DFSR = 0xe000ed30, AIRCR = 0xe000ed0c;
const DBGKEY = 0xa05f0000;
const C_DEBUGEN = 1, C_HALT = 2, C_STEP = 4, C_MASKINTS = 8;

/** 调试页默认 SWD 时钟（kHz）：PPB 访问必须 ≤1 MHz（见文件头 🚨1） */
export const DEFAULT_CLOCK_KHZ = 1000;

export class DebugSession {
  constructor(){
    this.probe = null;
    this.sym = null;                       // SymTab（载入 ELF 后才有）
    this.bps = [];                         // 断点地址（顺序 = 比较器槽位）
    this.caps = { numCode: 0, rev: 1, raw: 0 };
    this.halted = false;
    this.pc = 0;
    this.clockHz = DEFAULT_CLOCK_KHZ * 1000;
    this.backendName = 'WebUSB';
    this.name = '';
    this.idcode = 0;
    this.regs = [];                        // refreshRegs() 的缓存
    this.busy = false;                     // 正在做一次"用户动作"（按钮据此禁用）
    this.log = null;                       // (text, cls) => void
    this._prev = null;                     // 上一次读到的寄存器值（算 changed 高亮）
    this._cfbp = 0;
  }

  get connected(){ return !!this.probe; }
  get bpCapacity(){ return this.caps.numCode || 0; }

  _log(t, c){ try { this.log?.(t, c); } catch { /* 日志不影响主流程 */ } }

  // ------------------------------------------------------------ 连接

  /**
   * 连接目标。
   * @param {{mock?:boolean, clockKhz?:number, all?:boolean, bus?:object, stopBridge?:boolean, forcePick?:boolean}} opts
   *   mock=true 用内置的假目标（自测/演示，不需要硬件）
   *   bus = core/probe-bus.js 的 ProbeBus（会先请别的页签让出探针）
   */
  async connect(opts = {}){
    const { mock = false, clockKhz = DEFAULT_CLOCK_KHZ, all = false, bus = null, stopBridge = true, forcePick = false } = opts;
    if (this.probe) throw new Error('已经连接了（先断开）');
    this.backendName = mock ? '模拟目标' : 'WebUSB';
    if (mock){
      const { MockTarget } = await import('./mock.js');
      this.probe = new MockTarget();
      await this.probe.connect();
      this.name = this.probe.name;
      this.idcode = this.probe.idcode >>> 0;
    } else {
      /**
       * ① 先请别的页签让出探针。WebUSB 一个接口同时只能被一个连接认领，
       *    别的页签还占着时这里只会拿到 `Unable to claim interface`（reset 也救不回来）。
       */
      if (bus?.supported){
        const r = await bus.requestRelease({ why: '调试页要占用探针' });
        if (r.asked) this._log(`跨页签协调：请 ${r.asked} 个其他页签让出探针，${r.acked} 个确认（等了 ${r.ms} ms）`, 'dim');
      }
      /**
       * ② 停掉本页「RTT 转发」的探针桥：它在**探针侧**轮询目标内存（约 1 kHz），
       *    与这里的寄存器/内存访问抢同一条 SWD —— 不停的话单步一次要等好几秒。
       */
      if (stopBridge){
        const fw = globalThis.__tools?.hid;
        if (fw?.last?.running){
          try { await fw.stop(); this._log('已停掉「RTT 转发」的探针桥（它一直在轮询目标内存，会跟调试抢探针）', 'warn'); }
          catch (e){ this._log('停 RTT 转发失败（继续）：' + (e?.message || e), 'warn'); }
        }
      }
      /** ③ 清掉本页签可能残留的僵尸连接（接口认领挂在连接上，丢引用不 close 会挡住重新认领） */
      try { const n = await closeProbeUsbDevices(); if (n) this._log(`关掉 ${n} 个残留的探针句柄`, 'dim'); } catch {}

      const openOnce = () => withTimeout(WebUsbDapProbe.open(this._auth[0], { clockKhz }), 20000, '连接探针');
      // 已经授权过的探针不用再弹选择框（也能让自动化跑起来）
      let auth = [];
      if (!forcePick){
        try { auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针'); }
        catch (e){ throw new Error(`${e.message} —— 浏览器 USB 服务可能被上一次中断的会话卡住了：刷新页面（或拔插一次探针）再试`); }
      }
      if (!auth.length){
        this.probe = await withTimeout(WebUsbDapProbe.request(all, { clockKhz }), 60000, '等你在浏览器里选探针');
      } else {
        this._auth = auth;
        try { this.probe = await openOnce(); }
        catch (e1){
          // 刚被别的会话用过的探针第一次常常连不上（接口还没释放干净）：等 1.2 s 再试一次
          this._log(`第一次连接失败（${e1.message}）—— 等 1.2 s 重试一次…`, 'warn');
          await sleep(1200);
          try { await closeProbeUsbDevices(); } catch {}
          this.probe = await openOnce();
        }
      }
      this.probe.onLog = s => this._log('   [usb] ' + s, 'dim');
      this.probe.fast = false;             // 严格档：调试动作全都要回读确认
      this.name = this.probe.name || 'CMSIS-DAP';
      this.idcode = this.probe.idcode >>> 0;
      this.clockHz = this.probe.clockHz || clockKhz * 1000;
    }
    this._log(`已连接：${this.name}　SWD ${(this.clockHz / 1000).toFixed(0)} kHz　IDCODE=0x${this.idcode.toString(16).toUpperCase()}`, 'ok');
    await this.refresh();
    await this.bpInit();
    return this;
  }

  async disconnect(){
    const p = this.probe;
    this.probe = null;
    this.halted = false; this.regs = []; this._prev = null;
    this.bps = [];
    if (p?.disconnect){
      try { await p.disconnect(); this._log('已断开探针', 'dim'); }
      catch (e){ this._log('断开探针时报错（忽略）：' + (e?.message || e), 'warn'); }
    }
  }

  // ------------------------------------------------------------ 状态

  /** 读 DHCSR 刷新"停住/在跑"，停住时顺手把 PC 也读回来 */
  async refresh(){
    if (!this.probe) return { halted: false, pc: 0 };
    const v = await this.probe._readWord(DHCSR);
    this.halted = ((v >>> 17) & 1) === 1;
    if (this.halted) this.pc = await this.readReg('PC');
    return this.statusInfo();
  }

  statusInfo(){
    return { halted: this.halted, pc: this.pc >>> 0, connected: this.connected, linked: this.probe?.lastOkAt ? true : undefined };
  }

  /** 不管现在是什么状态，先把目标停住（绝大多数操作都在停住状态下做） */
  async ensureHalted(){
    if (!await this.probe.isHalted()) await this.probe.halt();
    await this.refresh();
  }

  // ------------------------------------------------------------ 运行控制

  async halt(){
    await this.probe.halt();
    await this.refresh();
    await this.refreshRegs();
  }

  async run(){
    await this._clearDfsr();
    await this.probe.run();
    this.halted = false;
  }

  /**
   * 继续运行 —— 带"跨过断点"处理。
   *
   * 🚨 命中断点后 PC **停在断点那条指令的地址上**，而 FPB 是"取指地址命中就停"：
   *    直接写 C_HALT=0 让它跑，它会立刻再命中一次（用户看到的是"点了继续没反应"）。
   *    正确做法是 gdb/pyOCD 那一套：**先单步跨过它再继续**（step() 自己会临时摘比较器）。
   */
  async cont(){
    if (!this.halted) { await this.run(); return false; }
    const pc = (await this.readReg('PC')) & ~1;
    if (this._bpAt(pc) !== undefined){
      this._log(`PC 停在断点 0x${(pc >>> 0).toString(16)} 上：先单步跨过它再继续`, 'dim');
      await this.step();
    }
    await this.run();
    return true;
  }

  _bpAt(addr){
    return this.bps.find(b => (b & ~1) === (addr & ~1));
  }

  /**
   * 临时摘掉某个地址上的比较器跑一段（单步/继续时都要用）。
   * 不摘的话：PC 就停在断点地址上，"单步一条"会因为取指再次命中而原地不动。
   */
  async _withBpCleared(addr, fn){
    const hit = this._bpAt(addr);
    if (hit === undefined) return await fn();
    const saved = this.bps.slice();
    this.bps = saved.filter(b => (b & ~1) !== (addr & ~1));
    await this._programFpb();
    try { return await fn(); }
    finally { this.bps = saved; await this._programFpb(); }
  }

  /**
   * 单步一条指令。
   * 🚨 先看到 S_HALT 变 0 再等它变回 1 —— 写 C_STEP 的那一刻 DHCSR 还是旧值，
   *    只等"=1"会立刻返回（等于没等），界面上就是"单步没动"。
   * C_MASKINTS 让这一步不响应中断（gdb 的 stepi 语义），停下后由 run() 清掉。
   */
  async step(){
    if (!this.halted) throw new Error('目标在运行 —— 先「暂停」再单步');
    const pc = (await this.readReg('PC')) & ~1;
    await this._withBpCleared(pc, async () => {
      await this.probe._dhcsr(DBGKEY | C_DEBUGEN | C_HALT | C_STEP | C_MASKINTS);
      let sawRun = false;
      for (let i = 0; i < 400; i++){
        const v = await this.probe._readWord(DHCSR);
        const h = ((v >>> 17) & 1) === 1;
        if (!h) sawRun = true;
        else if (sawRun) break;
        await waitMs(1);
      }
    });
    await this.refresh();
    await this.refreshRegs();
  }

  /** 清调试事件标志（命中过断点后 DFSR.BKPT 会一直挂着，清掉才能判断下一次是怎么停的） */
  async _clearDfsr(){
    try { await this.probe.writeMem(DFSR, u32leBytes(0x1f)); } catch (e){ this._log('清 DFSR 失败（忽略）：' + (e?.message || e), 'dim'); }
  }

  /**
   * 复位（软件复位：AIRCR.SYSRESETREQ）。
   * 🚨 不用探针的 nRESET 引脚：本机好几块板根本没把 NRST 接到探针，"拉复位"看着成功其实没动；
   *    而 AIRCR 走内核寄存器，一定到。另外**复位前先写 C_HALT**，
   *    这样复位后内核停在复位向量上（标准的 "reset and halt"），不会跑飞。
   */
  async _resetCore(){
    await this.probe._dhcsr(DBGKEY | C_DEBUGEN | C_HALT);
    await this.probe.writeMem(AIRCR, u32leBytes(0x05fa0004));
    await waitMs(60);                       // 给目标 60 ms 真的复位（yieldTask 不受后台节流影响）
    try { await this.probe._targetInit(); }
    catch (e){ this._log('复位后重新初始化 SWD 失败（继续试）：' + (e?.message || e), 'warn'); }
  }

  async resetHalt(){
    await this._resetCore();
    await this.probe.halt();
    await this.refresh();
    await this.refreshRegs();
    return '软件复位（AIRCR.SYSRESETREQ）+ 停住';
  }

  async resetRun(){
    await this._resetCore();
    await this.run();
    return '软件复位（AIRCR.SYSRESETREQ）+ 运行';
  }

  // ------------------------------------------------------------ 寄存器

  /** 读一个寄存器；CFBP 里的四个特殊寄存器按字节拆出来 */
  async readReg(name){
    const info = regInfo(name);
    if (!info) throw new Error(`不认识的寄存器「${name}」`);
    if (isCfbpSub(info)) return cfbpGet(await this._readCfbp(), info.name);
    return (await this.probe.regRead(info.sel)) >>> 0;
  }

  /** 写一个寄存器（CFBP 子寄存器走"读-改-写"，别把兄弟字节冲掉） */
  async writeReg(name, value){
    const info = regInfo(name);
    if (!info) throw new Error(`不认识的寄存器「${name}」`);
    if (isCfbpSub(info)){
      const cur = await this._readCfbp();
      const next = cfbpSet(cur, info.name, value);
      await this.probe.regWrite(CFBP_SEL, next);
      this._cfbp = next;
      return next;
    }
    await this.probe.regWrite(info.sel, value >>> 0);
    return value >>> 0;
  }

  async _readCfbp(){
    this._cfbp = (await this.probe.regRead(CFBP_SEL)) >>> 0;
    return this._cfbp;
  }

  /** 读回全部寄存器（21 次 PPB 往返，1 MHz 下几十毫秒），并标出与上次相比变了的 */
  async refreshRegs(){
    if (!this.probe) return [];
    const list = [];
    for (const r of CORE_REGS){
      const v = await this.readReg(r.name);
      list.push({ name: r.name, value: v >>> 0, note: r.note, kind: 'core' });
    }
    const cfbp = await this._readCfbp();
    for (const s of SPECIAL_REGS){
      list.push({ name: s.name, value: cfbpGet(cfbp, s.name), shift: s.shift, kind: 'cfbp', note: s.note });
    }
    const prev = this._prev;
    for (const r of list) r.changed = !!prev && prev[r.name] !== undefined && prev[r.name] !== r.value;
    this._prev = Object.fromEntries(list.map(r => [r.name, r.value]));
    this.regs = list;
    this.pc = (list.find(r => r.name === 'PC')?.value || this.pc) >>> 0;
    return list;
  }

  regList(){ return this.regs; }

  // ------------------------------------------------------------ 内存

  async memRead(addr, len){
    if (!len) return new Uint8Array(0);
    const budget = Math.max(3000, Math.ceil(len / 32) * 200);
    return await withTimeout(this.probe.readMem(addr >>> 0, len >>> 0), budget, `读内存 ${len} 字节`);
  }

  async memWrite(addr, bytes){
    const budget = Math.max(3000, Math.ceil(bytes.length / 32) * 200);
    await withTimeout(this.probe.writeMem(addr >>> 0, bytes), budget, `写内存 ${bytes.length} 字节`);
  }

  // ------------------------------------------------------------ 断点（FPB）

  /** 读 FPB 的能力（比较器个数 / 版本），并把**上一次会话残留的比较器清掉** */
  async bpInit(){
    let raw = 0;
    try { raw = (await this.probe._readWord(FPB.CTRL)) >>> 0; }
    catch (e){ this._log('读 FPB 控制寄存器失败：' + (e?.message || e), 'warn'); }
    this.caps = decodeFpCtrl(raw);
    if (this.caps.numCode > 16) this.caps.numCode = 16;      // 明显是读花了，别按它分配
    this._log(`硬件断点：${this.caps.numCode} 个比较器（FPB rev${this.caps.rev}，CTRL=0x${raw.toString(16)}）`, 'dim');
    // 残留的比较器会让目标"莫名其妙停住"：接手时一律清空（标准调试器的做法）
    let stale = 0;
    for (let i = 0; i < this.caps.numCode; i++){
      try {
        const v = (await this.probe._readWord(compAddr(i))) >>> 0;
        if (v & 1){ stale++; await this.probe.writeMem(compAddr(i), u32leBytes(0)); }
      } catch { break; }
    }
    if (stale) this._log(`清掉了上次会话残留的 ${stale} 个硬件断点`, 'warn');
    // 有的内核（或某些安全状态）根本不给访问 FPB —— 这里失败不能把整次连接带崩
    try { await this.probe.writeMem(FPB.CTRL, u32leBytes(FP_CTRL_KEY | (this.caps.numCode ? 1 : 0))); }
    catch (e){ this._log('写 FPB 控制寄存器失败（这颗内核可能没有可用的 FPB）：' + (e?.message || e), 'warn'); }
  }

  bpList(){
    return this.bps.map((addr, i) => ({ addr: addr >>> 0, slot: i, sym: this.sym?.funcAt?.(addr & ~1)?.name || this.sym?.find?.(String(addr))?.name || '' }));
  }

  /** 加断点（返回 index 是 0 基，命令层显示时 +1） */
  async bpAdd(addr){
    addr = (addr >>> 0) & ~1;              // Thumb：断点只能落在半字边界
    if (!this.caps.numCode) throw new Error('这颗内核没有可用的 FPB 比较器（读回 FP_CTRL 说 0 个）—— 本页暂不支持软件断点');
    if (!canBreak(addr, this.caps.rev)) throw new Error(`FPB rev${this.caps.rev} 只能匹配 0x20000000 以下的地址（0x${addr.toString(16)} 超出范围）`);
    const dup = this.bps.findIndex(b => (b & ~1) === addr);
    if (dup >= 0) return { index: dup, warn: '这个地址上已经有断点了' };
    if (this.bps.length >= this.caps.numCode) throw new Error(`硬件断点已用完（上限 ${this.caps.numCode} 个）—— 先删掉一个`);
    this.bps.push(addr);
    await this._programFpb();
    return { index: this.bps.length - 1 };
  }

  async bpDel(addr){
    addr = (addr >>> 0) & ~1;
    const n = this.bps.length;
    this.bps = this.bps.filter(b => (b & ~1) !== addr);
    if (this.bps.length === n) return false;
    await this._programFpb();
    return true;
  }

  async bpClear(){
    const n = this.bps.length;
    this.bps = [];
    await this._programFpb();
    return n;
  }

  /** 把断点表写进比较器（每次都整体重排：第 i 个断点 = 第 i 号比较器，顺序稳定好排查） */
  async _programFpb(){
    const { slots, overflow, bad } = planComparators(this.bps, this.caps.numCode, this.caps.rev);
    if (overflow.length) this._log(`⚠ ${overflow.length} 个断点装不下（比较器只有 ${this.caps.numCode} 个）`, 'err');
    if (bad.length) this._log(`⚠ ${bad.length} 个断点地址超出 FPB rev${this.caps.rev} 的匹配范围`, 'err');
    for (let i = 0; i < slots.length; i++){
      await this.probe.writeMem(compAddr(i), u32leBytes(slots[i] || 0));
    }
    const enable = this.bps.length && this.caps.numCode ? 1 : 0;
    await this.probe.writeMem(FPB.CTRL, u32leBytes(FP_CTRL_KEY | enable));
    // 回读对账：这颗探针的 PPB 写偶发不落地，断点静默失效最难查
    for (let i = 0; i < slots.length; i++){
      const want = slots[i] || 0;
      const got = (await this.probe._readWord(compAddr(i))) >>> 0;
      if (got !== want) this._log(`⚠ 比较器 ${i} 回读 0x${got.toString(16)} ≠ 写入 0x${want.toString(16)}（断点可能不生效）`, 'warn');
    }
  }
}
