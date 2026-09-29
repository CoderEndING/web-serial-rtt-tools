/**
 * 模拟 RISC-V 目标（JTAG TAP + DTM/DMI + Debug Module + SBA + XPI flash + flashloader 行为）。
 *
 * 存在意义：探针被占用时，**离线**把整条烧录链路跑通 —— 而且不是"打桩常量"，
 * 是真的按位解释 `jtag.js` 生成的 JTAG 序列：
 *   · TAP 状态机（TMS/TDI 位流）→ 认 IR → 41 位 DMI 扫描（流水线一深）
 *   · DM 寄存器：dmcontrol / dmstatus / abstractcs / command / data0 / sbcs / sbaddress0 / sbdata0
 *   · SBA：32 位、自增、写地址即读、读数据即续读；错误位（写 1 清零）
 *   · 内存：64 KB SRAM（flashloader 就加载在这儿）
 *   · flashloader：按**入口表**的七个函数语义执行（init/erase/program/read/info/erase_chip/deinit），
 *     数据写进一块"XPI flash"数组 —— 所以"擦干净了没有、写进去的对不对"都能真验。
 *
 * 不模拟的部分（真机才能验）：真实 JTAG 时序/时钟、DMI busy 的时序、ROM API 内部的 XPI 寄存器舞蹈、
 * 真实 flash 的擦写时间与 SFDP 探测。
 */

import { DM, DMI_OP, DMI_STATUS, SBCS, sbcsBlock, sbcsHold } from '../../app/flash/hpm/jtag.js';
import { parseAlgoEntryTable, ENTRY_ORDER } from '../../app/flash/hpm/entry.js';

const STATUS = { success: 0, invalidArgument: 1, outOfRange: 2, timeout: 3, noFlash: 4 };

export class SimTarget {
  /**
   * @param {{ramSize?:number, flashSize?:number, sectorSize?:number, blockSize?:number}} [opts]
   */
  constructor(opts = {}){
    this.idcode = 0x1000563D;
    this.dtmcs = 0x71;                        // version=1, idle=7（与真探针一致）
    this.ramSize = opts.ramSize ?? 0x10000;   // 64 KB SRAM
    this.ram = new Uint8Array(this.ramSize);
    this.flash = new Uint8Array(opts.flashSize ?? 0x100000);   // 1 MB 外部 flash
    this.flash.fill(0xff);
    this.sectorSize = opts.sectorSize ?? 0x1000;               // 4 KB 扇区
    this.blockSize = opts.blockSize ?? 0x10000;                // 64 KB 块
    // DM 寄存器
    this.dm = {
      dmcontrol: 0, dmstatus: 0x2 | (1 << 8),   // version=2、allhalted=1（复位后停着）
      abstractcs: 0x2,                          // datacount=3
      command: 0, data0: 0, sbcs: sbcsBlock() & 0x000fffff,
      sbaddress: 0,
    };
    this.regs = new Uint32Array(32);            // x0..x31（a0 = x10 = regs[10]）
    this.pc = 0;
    this.halted = true;
    // flashloader 状态（由 algo 的静态区模拟）
    this.flashInited = false;
    this.flashInfo = { totalBytes: this.flash.length, sectorBytes: this.sectorSize, blockBytes: this.blockSize };
    this.progChunks = 0;
    this.eraseOps = 0;
    this.log = [];
    // 统计（自测断言用）
    this.stats = { scans: 0, dmiWrites: 0, dmiReads: 0, sbaReads: 0, sbaWrites: 0 };
  }

  // ---------------------------------------------------------------- JTAG 层
  /** 执行一批序列，返回"要捕获的序列"的 TDO 字节数组（与 CMSIS-DAP 的响应同形）*/
  jtagSequences(seqs){
    const out = [];
    for (const s of seqs){
      const tdo = this._runSequence(s);
      if (s.captureBytes > 0) out.push(tdo);
    }
    return Promise.resolve(out);
  }

  connectJtag(){ this.log.push('DAP_Connect(JTAG)'); return Promise.resolve(); }

  _runSequence(seq){
    const clocks = s_clocks(seq.info);
    const tms = !!(seq.info & 0x40);
    const capture = !!(seq.info & 0x80);
    const tdo = new Uint8Array(seq.tdi.length);
    for (let i = 0; i < clocks; i++){
      const tdi = (seq.tdi[i >> 3] >> (i & 7)) & 1;
      const bit = this._tick(tms, tdi);
      if (capture && bit) tdo[i >> 3] |= 1 << (i & 7);
    }
    return tdo;
  }

  /** TAP 状态机 + 移位寄存器（DR/IR）*/
  _tick(tms, tdi){
    const S = this.tap || (this.tap = { state: 'TLR', ir: 0, dr: 0, drBits: 0, irBits: 0, tdo: 0 });
    let out = 0;
    switch (S.state){
      case 'TLR':      S.state = tms ? 'TLR' : 'RTI'; break;
      case 'RTI':      S.state = tms ? 'SelDR' : 'RTI'; break;
      case 'SelDR':    S.state = tms ? 'SelIR' : 'CapDR'; break;
      case 'CapDR':    S.state = tms ? 'Ex1DR' : 'ShiftDR'; S.drBits = 0; S.dr = 0n; S.shiftOut = this._drShiftOut(S.ir); break;
      case 'ShiftDR': {
        // 先出后进：TDO 是**上一次**请求的响应（流水线一深）
        out = Number((S.shiftOut ?? 0n) & 1n);
        if (S.shiftOut != null) S.shiftOut >>= 1n;
        S.dr |= BigInt(tdi & 1) << BigInt(S.drBits++);
        S.state = tms ? 'Ex1DR' : 'ShiftDR';
        break;
      }
      case 'Ex1DR':    S.state = tms ? 'UpdDR' : 'ShiftDR'; break;
      case 'UpdDR':    S.state = tms ? 'SelDR' : 'RTI'; this._onUpdateDR(S); break;
      case 'SelIR':    S.state = tms ? 'TLR' : 'CapIR'; break;
      case 'CapIR':    S.state = tms ? 'Ex1IR' : 'ShiftIR'; S.irBits = 0; S.ir = 0; break;
      case 'ShiftIR':
        S.ir |= (tdi & 1) << S.irBits++;
        S.state = tms ? 'Ex1IR' : 'ShiftIR';
        break;
      case 'Ex1IR':    S.state = tms ? 'UpdIR' : 'ShiftIR'; break;
      case 'UpdIR':    S.state = tms ? 'SelDR' : 'RTI'; this._onUpdateIR(S); break;
      default:         S.state = 'TLR'; break;
    }
    return out;
  }

  /**
   * 每次进入 Shift-DR 都要**重新装**要移出的值（一深流水线的响应、IDCODE、DTMCS）。
   * 🚨 早期只在 Update-IR 时装一次，于是同一条 IR 下的第二次扫描移出的还是上次被移空了的寄存器
   *    （全 0）—— 表现是"IDCODE 读到了、dmstatus 全是 0"。
   */
  _drShiftOut(ir){
    const i = ir & 0x1f;
    if (i === 0x01) return BigInt(this.idcode);
    if (i === 0x10) return BigInt(this.dtmcs);
    if (i === 0x11) return this.pendingDmi ?? 0n;
    return 0n;
  }

  _onUpdateIR(S){
    S.ir &= (1 << S.irBits) - 1;
    this.log.push(`IR=0x${S.ir.toString(16)}`);
  }

  _onUpdateDR(S){
    if ((S.ir & 0x1f) === 0x01){
      return;                                   // IDCODE：只读
    }
    if ((S.ir & 0x1f) !== 0x11) return;
    this.stats.scans++;
    // 41 位 DMI：op(2) | data(32)<<2 | addr(7)<<34
    const req = S.dr & ((1n << 41n) - 1n);
    const op = Number(req & 0x3n);
    const data = Number((req >> 2n) & 0xffffffffn) >>> 0;
    const addr = Number((req >> 34n) & 0x7fn);
    this.pendingDmi = this._dmiExecute(op, addr, data);
  }

  /** 执行一条 DMI 请求，返回 41 位响应（op 在低 2 位）*/
  _dmiExecute(op, addr, data){
    const enc = (opCode, payload) => BigInt(opCode & 0x3) | (BigInt(payload >>> 0) << 2n);
    if (op === DMI_OP.NOP) return enc(DMI_STATUS.SUCCESS, 0);
    if (op === DMI_OP.READ){
      this.stats.dmiReads++;
      return enc(DMI_STATUS.SUCCESS, this._readReg(addr));
    }
    if (op === DMI_OP.WRITE){
      this.stats.dmiWrites++;
      this._writeReg(addr, data);
      return enc(DMI_STATUS.SUCCESS, 0);
    }
    return enc(DMI_STATUS.ERROR, 0);
  }

  _readReg(addr){
    const d = this.dm;
    switch (addr){
      case DM.DMSTATUS: return (d.dmstatus | (this.halted ? 1 << 8 : 0)) >>> 0;
      case DM.DMCONTROL: return d.dmcontrol >>> 0;
      case DM.ABSTRACTCS: return d.abstractcs >>> 0;
      case DM.COMMAND: return d.command >>> 0;
      case DM.DATA0: return d.data0 >>> 0;
      case DM.SBCS: {
        // sbbusy / sbbusyerror / sberror 由 SBA 状态决定；配置位回读
        return (d.sbcs | (this.sbaBusyError ? SBCS.SBBUSYERROR : 0) | (this.sbaError ? SBCS.SBERROR : 0)) >>> 0;
      }
      case DM.SBADDRESS0: return d.sbaddress >>> 0;
      case DM.SBDATA0: {
        this.stats.sbaReads++;
        const v = this._sbaLoad();
        if (d.sbcs & SBCS.SBAUTOINC) d.sbaddress = (d.sbaddress + 4) >>> 0;
        if (!(d.sbcs & SBCS.SBREADONDATA)) { /* 只在读地址时启动 */ }
        return v;
      }
      default: return 0;
    }
  }

  _writeReg(addr, data){
    const d = this.dm;
    switch (addr){
      case DM.DMCONTROL: {
        const wasActive = !!(d.dmcontrol & 1);
        const wasReset = !!(d.dmcontrol & 2);
        d.dmcontrol = data >>> 0;
        if (data & (1 << 31)){ this.halted = true; }                  // haltreq
        if (data & (1 << 30)){                                        // resumereq
          this.halted = false;
          this._onResume();
        }
        if (!wasActive && (data & 1)) this.halted = true;             // dmactive 上升沿：DM 复位、hart 停住
        // ndmreset 是电平式：拉高=拉复位、拉低=核从复位向量开始跑
        if ((data & 2) && !wasReset) this.resetPulse = true;
        if (!(data & 2) && wasReset){ this.resetPulse = false; this.halted = false; this.pc = 0; }
        break;
      }
      case DM.COMMAND: {
        d.command = data >>> 0;
        this._onAbstract(data >>> 0);
        break;
      }
      case DM.DATA0: d.data0 = data >>> 0; break;
      case DM.SBCS: {
        // 写 1 清零错误位；其余位是配置
        if (data & (SBCS.SBBUSYERROR | SBCS.SBERROR)){ this.sbaBusyError = false; this.sbaError = false; }
        d.sbcs = (data & ~(SBCS.SBBUSYERROR | SBCS.SBERROR)) >>> 0;
        break;
      }
      case DM.SBADDRESS0: {
        d.sbaddress = data >>> 0;
        if (d.sbcs & SBCS.SBREADONADDR) this._sbaStartRead();
        break;
      }
      case DM.SBDATA0: {
        this.stats.sbaWrites++;
        this._sbaStore(data >>> 0);
        if (d.sbcs & SBCS.SBAUTOINC) d.sbaddress = (d.sbaddress + 4) >>> 0;
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- SBA
  _sbaStartRead(){
    // 读地址即发起第一次读：值放在 data0（由 SBDATA0 的读取走）
    this.sbaNext = this._loadWord(this.dm.sbaddress);
  }

  _sbaLoad(){
    if (this.sbaNext !== undefined){ const v = this.sbaNext; this.sbaNext = undefined; return v; }
    return this._loadWord(this.dm.sbaddress);
  }

  _sbaStore(v){
    const a = this.dm.sbaddress >>> 0;
    if (a < this.ramSize){
      const dv = new DataView(this.ram.buffer, a, 4);
      dv.setUint32(0, v, true);
      // 写进 RAM 的可能是 flashloader 的代码/数据，也可能是普通数据 —— 都一样处理
    } else {
      this.sbaError = true;                     // 写到没映射的地址：置错误位（真机也是这样）
    }
  }

  _loadWord(a){
    a = a >>> 0;
    if (a < this.ramSize){
      const dv = new DataView(this.ram.buffer, a, 4);
      return dv.getUint32(0, true);
    }
    this.sbaError = true;
    return 0;
  }

  // ---------------------------------------------------------------- 目标核 + flashloader
  /**
   * resume：看 pc 落在**入口表的哪一项**，就"执行"那个函数（模拟算法的效果）。
   * 入口表是**从 RAM 里现解析的**（flashloader 刚被 SBA 写进去），和真机"跑到那个地址"同构 ——
   * 所以主机侧改了入口偏移/顺序，这里立刻就不认（而不是靠测试代码自己告诉模拟器调哪个函数）。
   */
  _onResume(){
    const table = this._entryTable();
    // 🚨 pc 指的是**表项位置**（loadAddr + entryOffset，init 就是 0），不是 jal 的落点
    const hit = table.find(e => e.entryOffset === (this.pc >>> 0));
    if (!hit) { this.log.push(`resume pc=0x${this.pc.toString(16)}（不是算法入口，当作普通运行）`); return; }
    const entry = ENTRY_ORDER[table.indexOf(hit)];
    const a0 = this.regs[10], a1 = this.regs[11], a2 = this.regs[12], a3 = this.regs[13], a4 = this.regs[14];
    void a4;
    let rc = STATUS.success;
    switch (entry){
      case 'init':  rc = this._flashInit(a0, a2, a3); break;
      case 'erase': rc = this._flashErase(a0, a1, a2); break;
      case 'program': rc = this._flashProgram(a0, a1, a2, a3); break;
      // 参数顺序照 README 的签名：flash_read(flash_base, buf, address, size) → a0..a3
      case 'read':  rc = this._flashRead(a0, a1, a2, a3); break;
      case 'info':  rc = this._flashInfo(a0, a1); break;
      case 'eraseChip': rc = this._flashEraseChip(); break;
      case 'deinit': rc = STATUS.success; break;
      default: rc = STATUS.invalidArgument;
    }
    this.regs[10] = rc >>> 0;                    // a0 = 返回码
    this.halted = true;                          // ebreak → halt
  }

  /** 从 RAM 里现解析 flashloader 的入口表（缓存）*/
  _entryTable(){
    if (this._table) return this._table;
    const view = this.ram.subarray(0, 0x200);
    this._table = parseAlgoEntryTable(view);
    return this._table;
  }

  _flashInit(flashBase, opt0, opt1){
    this.flashInited = true;
    this.log.push(`flash_init(base=0x${flashBase.toString(16)}, opt0=0x${opt0.toString(16)}, opt1=0x${opt1.toString(16)})`);
    return STATUS.success;
  }

  _flashErase(flashBase, addr, size){
    if (!this.flashInited) return STATUS.noFlash;
    const off = (addr >>> 0) - (flashBase >>> 0);
    if (off < 0 || off + size > this.flash.length) return STATUS.outOfRange;
    // 真算法按扇区擦；这里按扇区把区间标成 0xFF
    const from = Math.floor(off / this.sectorSize) * this.sectorSize;
    const to = Math.ceil((off + size) / this.sectorSize) * this.sectorSize;
    this.flash.fill(0xff, from, Math.min(to, this.flash.length));
    this.eraseOps++;
    this.log.push(`flash_erase(0x${addr.toString(16)}, ${size} B) → 擦 ${to - from} B`);
    return STATUS.success;
  }

  _flashEraseChip(){
    this.flash.fill(0xff);
    this.eraseOps++;
    return STATUS.success;
  }

  _flashProgram(flashBase, addr, bufAddr, size){
    if (!this.flashInited) return STATUS.noFlash;
    const off = (addr >>> 0) - (flashBase >>> 0);
    if (off < 0 || off + size > this.flash.length) return STATUS.outOfRange;
    if (bufAddr + size > this.ramSize) return STATUS.invalidArgument;
    const src = this.ram.subarray(bufAddr, bufAddr + size);
    /**
     * NOR flash 的编程语义是**按位与**：只能把 1 写成 0，写 1 到已经是 0 的位不会把它变回 1
     * （硬件不报错，只是写不进去）。所以"没擦就写"不会当场失败，而是**校验时**露馅 ——
     * 这正是真机上的表现，模拟器照做，别把它变成"编程返回错误"。
     */
    for (let i = 0; i < size; i++){
      const merged = this.flash[off + i] & src[i];
      if (merged !== src[i]) this.programWithoutErase = true;    // 诊断标志（自测里断言它被置起）
      this.flash[off + i] = merged;
    }
    this.progChunks++;
    return STATUS.success;
  }

  _flashRead(flashBase, bufAddr, addr, size){
    const off = (addr >>> 0) - (flashBase >>> 0);
    if (off < 0 || off + size > this.flash.length) return STATUS.outOfRange;
    if (bufAddr + size > this.ramSize) return STATUS.invalidArgument;
    this.ram.set(this.flash.subarray(off, off + size), bufAddr);
    return STATUS.success;
  }

  _flashInfo(flashBase, infoAddr){
    if (!infoAddr || infoAddr + 8 > this.ramSize) return STATUS.invalidArgument;
    const dv = new DataView(this.ram.buffer, infoAddr, 8);
    dv.setUint32(0, this.flashInfo.totalBytes, true);
    dv.setUint32(4, this.flashInfo.sectorBytes, true);
    return STATUS.success;
  }

  /**
   * 抽象命令（Access Register / Access Memory）。
   * 烧录流程靠它：写 a0..a4（参数）、写 dpc（跳到算法入口）、读 a0（返回码）。
   */
  _onAbstract(command){
    const cmdtype = (command >>> 29) & 0x7;
    const regno = command & 0xffff;
    const write = !!((command >>> 16) & 1);
    const transfer = !!((command >>> 17) & 1);
    if (cmdtype === 0){                                  // Access Register
      if (!transfer) return;
      const isPc = regno === 0x7c1;
      const isX = regno >= 0x1000 && regno < 0x1020;
      if (write){
        if (isPc) this.pc = this.dm.data0 >>> 0;
        else if (isX) this.regs[regno - 0x1000] = this.dm.data0 >>> 0;
      } else {
        this.dm.data0 = isPc ? this.pc >>> 0 : (isX ? this.regs[regno - 0x1000] : 0);
      }
      return;
    }
    if (cmdtype === 2){                                  // Access Memory（本工程没用到，留着以防将来）
      const size = 1 << ((command >>> 20) & 0x7);
      const addr = this.regs[11] >>> 0;                  // s1 = 地址（规范：地址放 x1? 实际是 s1=x9）
      void size; void addr;
    }
  }

}

/** CMSIS-DAP 序列 info 字节 → 拍数（0 = 64）*/
function s_clocks(info){
  const n = info & 0x3f;
  return n === 0 ? 64 : n;
}
