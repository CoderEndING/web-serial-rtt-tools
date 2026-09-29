/**
 * RISC-V 调试模块访问（DMI + SBA），跑在 CMSIS-DAP 的 JTAG 序列之上。
 *
 * 分层（**传输是注入的**，所以同一套协议代码既能驱动真探针，也能被模拟 DTM 驱动）：
 *
 *   RiscvTransport（本文件） ← 需要一个 `dap`：
 *       { jtagSequences(seqs) -> Promise<Uint8Array[]>   // 每条序列的 TDO 字节
 *         connectJtag() -> Promise<void> }               // DAP_Connect(JTAG) + 配置
 *   ↑ 真机：app/flash/hpm/dap-transport.js（走 WebUSB interface 0 的 CMSIS-DAP v2）
 *   ↑ 自测：tools/selftest/hpm-flash.test.mjs 里的模拟 DTM
 *
 * 关键协议点（与探针固件 `riscv_jtag.c` 的做法逐条对齐，那份在 HPM6800EVK 上跑通过）：
 *   · **DMI 是流水线**：每次扫描拿回的是**上一次**请求的响应，所以 read = 发 READ + 发 NOP 收结果；
 *     连续写可以一直 posted，只在需要确认时补一次 NOP。
 *   · `dtmcs.idle` 要求扫描之间给若干 RTI 拍（本探针实测 7，见固件注释），默认 8。
 *   · SBA 块访问：`sbcs = 32 位 + 自增 + 写地址即读 + 读数据即续读`，
 *     写 `sbaddress0` 就发起第一次读，之后每读一次 `sbdata0` 就自动开始下一次。
 *   · 出错（sbbusyerror / sberror）**写 1 清零**，写 0 等于没做 —— 固件里踩过这个坑
 *     （"搬了一块就再也搬不动"），这里照它的做法处理。
 */

import { DM, DMI_OP, DMI_STATUS, SBCS, sbcsBlock, sbcsHold, dmiRequest, dmiResponse,
         tapReset, tapLoadIR, drScan, gatherTDO, bitsToUint, abstractCommand, ABSTRACTCS, DMSTATUS,
         DMCONTROL, CMDTYPE, REGNO } from './jtag.js';

/** IR 值（RISC-V DTM 规范：0x01 = IDCODE、0x10 = DTMCS、0x11 = DMI） */
export const IR_IDCODE = 0x01;
export const IR_DTMCS = 0x10;
export const IR_DMI = 0x11;
/** DR 位宽 */
export const DR_DMI_BITS = 41;
export const DR_DTMCS_BITS = 32;
export const DR_IDCODE_BITS = 32;

export class RiscvTransport {
  /**
   * @param {{jtagSequences:(seqs:Array)=>Promise<Uint8Array[]>, connectJtag?:()=>Promise<void>}} dap
   * @param {{idle?:number, log?:Function}} [opts]
   */
  constructor(dap, opts = {}){
    this.dap = dap;
    this.idle = opts.idle ?? 8;              // DTM 要求的 RTI 拍（探针固件默认 8）
    this.log = opts.log || (() => {});
    this.open = false;
    this.lastDtmcs = 0;
    this.lastDmstatus = 0;
    this.lastSbcs = 0;
    this.scans = 0;
    this.sbaFailed = false;
    this._sbcsCfg = null;
    this._holdAddr = null;
  }

  /** 打开 TAP：复位 → 读 IDCODE（IR=0x01）→ 装 IR=DMI → 读 DTMCS/DMSTATUS 确认 DM 活着 */
  async init(){
    await this.dap.connectJtag?.();
    await this.sequences(tapReset());
    await this.sequences(tapLoadIR(IR_IDCODE));
    this.idcode = Number((await this._scanDR(DR_IDCODE_BITS, 0n)) & 0xffffffffn) >>> 0;
    // DTMCS 在 IR=0x10（不是 0x11！0x11 是 DMI）：写 0 = 不要求任何特性，读回 idle/版本等信息
    await this.sequences(tapLoadIR(IR_DTMCS));
    this.lastDtmcs = Number((await this._scanDR(DR_DTMCS_BITS, 0n)) & 0xffffffffn) >>> 0;
    await this.sequences(tapLoadIR(IR_DMI));
    this.lastDmstatus = (await this.dmiRead(DM.DMSTATUS)) >>> 0;
    this.open = true;
    this.log(`RISC-V DM：idcode=0x${this.idcode.toString(16)} dtmcs=0x${this.lastDtmcs.toString(16)} ` +
             `dmstatus=0x${this.lastDmstatus.toString(16)}（version=${DMSTATUS.version(this.lastDmstatus)}）`);
    return { idcode: this.idcode, dtmcs: this.lastDtmcs, dmstatus: this.lastDmstatus };
  }

  /**
   * 一次 DR 扫描，返回**移出位**拼成的 BigInt（低位先出，所以 bit i = 第 i 个移出的位）。
   *
   * 🚨 位对齐很容易写错：只有带 capture 的序列会回 TDO，而**每条序列回了多少位**由它的拍数决定
   *    （不是字节数）。这里逐条按位收集，避免"按字节拼接"把最后那条 1 拍的序列算成 8 位。
   */
  async _scanDR(nbits, tdi){
    const seqs = drScan(nbits, tdi, { idle: this.idle });
    const caps = await this.sequences(seqs);
    const bits = [];
    let ci = 0;
    for (const s of seqs){
      if (!s.captureBytes) continue;
      const bytes = caps[ci++];
      const clocks = s.clocks >= 64 ? 64 : s.clocks;
      for (let i = 0; i < clocks; i++) bits.push((bytes[i >> 3] >> (i & 7)) & 1);
    }
    let v = 0n;
    for (let i = 0; i < bits.length && i < nbits; i++) if (bits[i]) v |= (1n << BigInt(i));
    this.scans++;
    return v;
  }

  /** 把一批序列交给下层（真机是一条 DAP_JTAG_Sequence 命令，模拟器直接执行）*/
  async sequences(seqs){
    const caps = await this.dap.jtagSequences(seqs);
    if (!caps || caps.length !== seqs.filter(s => s.captureBytes > 0).length){
      // 下层的返回长度必须与"要捕获的序列条数"一致，否则位对齐全错（宁可报错也别继续）
      throw new Error(`JTAG 序列返回条数不对：期望 ${seqs.filter(s => s.captureBytes > 0).length}，实际 ${caps?.length}`);
    }
    return caps;
  }

  /** 发一条 DMI 请求，返回**上一次**请求的响应（流水线语义）*/
  async dmiPost(op, addr = 0, data = 0){
    const bits = await this._scanDR(DR_DMI_BITS, dmiRequest(op, addr, data));
    return dmiResponse(bits);
  }

  /** 同步 DMI 读（两次扫描；DM busy 时重试）*/
  async dmiRead(addr){
    for (let i = 0; i < 8; i++){
      await this.dmiPost(DMI_OP.READ, addr, 0);          // 冲掉上一条挂起的响应
      const r = await this.dmiPost(DMI_OP.NOP, 0, 0);    // 这条才是读的结果
      if (r.op === DMI_STATUS.SUCCESS) return r.data;
      if (r.op !== DMI_STATUS.BUSY) throw new Error(`DMI 读 0x${addr.toString(16)} 失败（op=${r.op}）`);
    }
    throw new Error(`DMI 读 0x${addr.toString(16)} 一直 BUSY`);
  }

  /** 同步 DMI 写（发 + 用一次 NOP 收状态）*/
  async dmiWrite(addr, data){
    await this.dmiPost(DMI_OP.WRITE, addr, data);
    const r = await this.dmiPost(DMI_OP.NOP, 0, 0);
    if (r.op !== DMI_STATUS.SUCCESS) throw new Error(`DMI 写 0x${addr.toString(16)} 失败（op=${r.op}）`);
  }

  // ---------------------------------------------------------------- 目标控制
  /** 让 DM 上线（dmactive=1）并选 hart 0 */
  async activate(hart = 0){
    await this.dmiWrite(DM.DMCONTROL, (DMCONTROL.dmactive | DMCONTROL.hartsel(hart)) >>> 0);
    const st = await this.dmiRead(DM.DMSTATUS);
    return st;
  }

  /** 请求 halt（写 haltreq 后轮询 allhalted）*/
  async halt(hart = 0, timeoutMs = 2000){
    await this.dmiWrite(DM.DMCONTROL, (DMCONTROL.dmactive | DMCONTROL.hartsel(hart) | DMCONTROL.haltreq) >>> 0);
    return await this.waitHalted(timeoutMs);
  }

  /**
   * 等核停下来 —— **只轮询，不写 haltreq**。
   * 🚨 烧录算法就是靠"跑完最后一条 ebreak 自然停住"来交差的：这里要是再写一次 haltreq，
   *    会把还在擦/写的算法当场打断，返回码变成垃圾（而界面会显示"成功"或莫名其妙的错误）。
   */
  async waitHalted(timeoutMs = 20000){
    const t0 = Date.now();
    for (;;){
      const st = await this.dmiRead(DM.DMSTATUS);
      if (st & DMSTATUS.allhalted) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等目标 halt 超时（${timeoutMs} ms，dmstatus=0x${st.toString(16)}）`);
    }
  }

  /** 系统复位后运行（HPM 的 SoC 复位：RISC-V 的 ndmreset）—— 烧完让固件自己跑起来 */
  async resetRun(hart = 0){
    // ndmreset 是电平式：拉高 → 稍等 → 拉低（清 haltreq，让核从复位向量开始跑）
    await this.dmiWrite(DM.DMCONTROL, (DMCONTROL.dmactive | DMCONTROL.hartsel(hart) | DMCONTROL.ndmreset) >>> 0);
    await new Promise(r => setTimeout(r, 50));
    await this.dmiWrite(DM.DMCONTROL, (DMCONTROL.dmactive | DMCONTROL.hartsel(hart)) >>> 0);
    await new Promise(r => setTimeout(r, 10));
  }

  /** 让目标跑起来（resumereq），可选先写 pc */
  async resume(pc = null, hart = 0){
    if (pc != null) await this.writeReg(REGNO.PC, pc >>> 0);
    await this.dmiWrite(DM.DMCONTROL, (DMCONTROL.dmactive | DMCONTROL.hartsel(hart) | DMCONTROL.resumereq) >>> 0);
  }

  /** 读一个 hart 寄存器（x0..x31 = 0x1000+n、dpc = 0x7c1）*/
  async readReg(regno){
    const { command } = abstractCommand({ regno, write: false, aarsize: 2 });
    await this.dmiWrite(DM.COMMAND, command);
    await this._waitAbstract();
    if ((regno & 0xfff) >= 0x000 && regno < 0x1000 && regno !== REGNO.PC){
      // 通用寄存器走 data0；CSR/dpc 走 data0 也成立（规范：除浮点外都在 data0）
    }
    return await this.dmiRead(DM.DATA0);
  }

  /** 写一个 hart 寄存器；返回写下去的 32 位值 */
  async writeReg(regno, value){
    await this.dmiWrite(DM.DATA0, value >>> 0);
    const { command } = abstractCommand({ regno, write: true, aarsize: 2 });
    await this.dmiWrite(DM.COMMAND, command);
    await this._waitAbstract();
    return value >>> 0;
  }

  async _waitAbstract(timeoutMs = 2000){
    const t0 = Date.now();
    for (;;){
      const cs = await this.dmiRead(DM.ABSTRACTCS);
      if (!(cs & ABSTRACTCS.busy)){
        const err = ABSTRACTCS.cmderr(cs);
        if (err) throw new Error(`抽象命令出错（cmderr=${err}，abstractcs=0x${cs.toString(16)}）`);
        return cs;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error('抽象命令一直 busy');
    }
  }

  // ---------------------------------------------------------------- SBA（系统总线）
  async sbaConfig(extra = sbcsBlock()){
    if (this.sbaFailed){ await this.sbaClearErrors(); this.sbaFailed = false; }
    if (this._sbcsCfg === extra) return;
    await this.dmiWrite(DM.SBCS, extra >>> 0);
    this._sbcsCfg = extra >>> 0;
    this.lastSbcs = extra >>> 0;
  }

  /** sberror/sbbusyerror 是**写 1 清零**（固件里踩过"写 0 等于没做"）*/
  async sbaClearErrors(){
    const sbcs = await this.dmiRead(DM.SBCS);
    this.lastSbcs = sbcs;
    if (sbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)){
      await this.dmiWrite(DM.SBCS, (sbcs | SBCS.SBBUSYERROR | SBCS.SBERROR) >>> 0);
    }
    this._sbcsCfg = null;                 // 清错之后配置要重写
  }

  /** 块读：addr 可以不对齐；返回 length 字节 */
  async readMem(addr, length){
    if (length <= 0) return new Uint8Array(0);
    const out = new Uint8Array(length);
    const start = (addr >>> 0) & ~3;
    const first = (addr >>> 0) - start;                 // 头部补齐
    const words = Math.ceil((first + length) / 4);
    await this.sbaConfig();
    this._holdAddr = null;
    await this.dmiWrite(DM.SBADDRESS0, start);
    for (let i = 0; i < words; i++){
      const w = await this.dmiRead(DM.SBDATA0);
      this.lastSbcs = await this.dmiRead(DM.SBCS);
      if (this.lastSbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)){
        this.sbaFailed = true;
        throw new Error(`SBA 读 0x${(start + i * 4).toString(16)} 出错（sbcs=0x${this.lastSbcs.toString(16)}）`);
      }
      const b = [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff];
      for (let k = 0; k < 4; k++){
        const pos = i * 4 + k - first;
        if (pos >= 0 && pos < length) out[pos] = b[k];
      }
    }
    return out;
  }

  /** 块写：addr 必须 4 字节对齐、length 必须是 4 的倍数（flashloader 的 buf 就是这么用的）*/
  async writeMem(addr, bytes){
    if (bytes.length % 4) throw new Error(`SBA 写要求 4 字节对齐（长度 ${bytes.length}）`);
    if ((addr >>> 0) % 4) throw new Error(`SBA 写要求 4 字节对齐（地址 0x${(addr >>> 0).toString(16)}）`);
    await this.sbaConfig();
    this._holdAddr = null;
    await this.dmiWrite(DM.SBADDRESS0, addr >>> 0);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let off = 0; off < bytes.length; off += 4){
      await this.dmiWrite(DM.SBDATA0, dv.getUint32(off, true));
    }
    // posted 写：用一次 NOP 扫描 + 读 sbcs 确认没有攒着的错误
    await this.dmiPost(DMI_OP.NOP, 0, 0);
    this.lastSbcs = await this.dmiRead(DM.SBCS);
    if (this.lastSbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)){
      this.sbaFailed = true;
      throw new Error(`SBA 写 0x${(addr >>> 0).toString(16)} 出错（sbcs=0x${this.lastSbcs.toString(16)}）`);
    }
  }

  /**
   * 单字流水读（J-Scope 的单变量快路径同构）：把 SBA 抱在同一个地址上（关自增），
   * 之后每拍只有一次 DMI 扫描；延迟一拍 —— 第一次的结果要丢掉，最后一个值由调用方补收。
   */
  async holdPrepare(addr){
    const a = (addr >>> 0) & ~3;
    if (this._holdAddr === a) return;
    await this.sbaConfig(sbcsHold());
    await this.dmiWrite(DM.SBADDRESS0, a);
    this._holdAddr = a;
    await this.dmiPost(DMI_OP.READ, DM.SBDATA0, 0);      // 投出第一次读（结果下一拍才回来）
    await this.dmiPost(DMI_OP.NOP, 0, 0);                // 丢掉那一次
  }

  async holdRead(){
    const r = await this.dmiPost(DMI_OP.READ, DM.SBDATA0, 0);
    if (r.op !== DMI_STATUS.SUCCESS) return null;
    return r.data;
  }
}
