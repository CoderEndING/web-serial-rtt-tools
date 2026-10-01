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

import { DM, DMI_OP, DMI_STATUS, SBCS, sbcsBlock, sbcsWrite, sbcsHold, dmiRequest, dmiResponse,
         tapReset, tapLoadIR, drScan, bitsToUint, abstractCommand, ABSTRACTCS, DMSTATUS, DMSTATUS_LAYOUT,
         DMCONTROL, CMDTYPE, REGNO, DCSR_EBREAK, PROGBUF_FENCE } from './jtag.js';

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
    this._burstOff = false;    // 批量读被真机拒绝过就关掉（见 readMem / sbaReadBurst）
    this._burstMiss = 0;
    this._holdAddr = null;
    this.dmLayout = null;      // dmstatus 的位布局（'legacy' = halted 在 bit8/9，'spec' = bit14/15），init 时实测
  }

  /**
   * 打开 TAP 并唤醒 DM —— 顺序**照探针固件 `riscv_jtag_open()`**（那份在 HPM6800EVK 上跑通过）：
   *   ① TAP 复位 → IR=0x01 读 IDCODE（0 / 0xFFFFFFFF 视为没人）
   *   ② IR=0x10 读 DTMCS
   *   ③ 🚨 **再走一次 TAP 复位**：dtmcs/idcode 扫描之后 DTM 就不应答 DMI 了（固件实测记下的坑）
   *   ④ 装 IR=0x11，先投两条 NOP 把 DMI 流水线排空
   *   ⑤ 🚨 `dmcontrol` **写 0 再写 1**（不是只写 1）：写 0 会复位 DM、中止进行中的操作 ——
   *      这是 SBA 卡死（读到没挂载的地址导致 sbbusy 永久挂起）之后唯一的解药
   *   ⑥ 读 dmstatus 作为"DM 真的醒了吗"的判据
   */
  async init(){
    await this.dap.connectJtag?.();
    await this.sequences(tapReset());
    await this.sequences(tapLoadIR(IR_IDCODE));
    this.idcode = Number((await this._scanDR(DR_IDCODE_BITS, 0n)) & 0xffffffffn) >>> 0;
    if (!this.idcode || this.idcode === 0xffffffff) throw new Error('JTAG 链上没读到 IDCODE（0/全 1）——接线或供电？');
    await this.sequences(tapLoadIR(IR_DTMCS));
    this.lastDtmcs = Number((await this._scanDR(DR_DTMCS_BITS, 0n)) & 0xffffffffn) >>> 0;

    // ③ dtmcs/idcode 扫描之后必须回 Test-Logic-Reset，否则 DMI 不应答
    await this.sequences(tapReset());
    await this.sequences(tapLoadIR(IR_DMI));
    // ④ 排空 DMI 流水线
    await this.dmiPost(DMI_OP.NOP, 0, 0);
    await this.dmiPost(DMI_OP.NOP, 0, 0);
    // ⑤ DM 复位（0）再唤醒（1）
    await this.dmiWrite(DM.DMCONTROL, 0);
    await this.dmiWrite(DM.DMCONTROL, DMCONTROL.dmactive);
    // ⑥ 判据
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

  /**
   * 同步 DMI 读（两次扫描；DM busy 时重试）。
   * 🚨 整个重试循环有**墙钟上限**（默认 5 s）：探针固件在"目标总线被卡住的 SBA 读"之后
   *    可能连 DMI 都不应答，没有上限的话这里会一轮轮重试到几分钟，界面看着就是"卡死"
   *    （2026-10 真机踩到：SBA 读一个外设寄存器 → 之后整条链路都在等超时）。
   */
  async dmiRead(addr, timeoutMs = 5000){
    const t0 = Date.now();
    for (let i = 0; i < 8; i++){
      await this.dmiPost(DMI_OP.READ, addr, 0);          // 冲掉上一条挂起的响应
      const r = await this.dmiPost(DMI_OP.NOP, 0, 0);    // 这条才是读的结果
      if (r.op === DMI_STATUS.SUCCESS) return r.data;
      if (r.op !== DMI_STATUS.BUSY) throw new Error(`DMI 读 0x${addr.toString(16)} 失败（op=${r.op}）`);
      if (Date.now() - t0 > timeoutMs){
        throw new Error(`DMI 读 0x${addr.toString(16)} 一直 BUSY（超过 ${timeoutMs} ms）——` +
          ' 目标总线/外设不响应，或 DM 处于复位中');
      }
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
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart));
    const st = await this.dmiRead(DM.DMSTATUS);
    return st;
  }

  /**
   * 让 hart 停下来：**只写 haltreq**（与 OpenOCD 一致，2026-10 真机标定过）。
   *
   * 🚨 曾经的错误做法：`dmactive|ndmreset|haltreq` → 松 ndmreset（"reset halt"那套）。
   *    那个写法**会顺手把整个 SoC 复位一次**，核被停在 boot ROM 的复位向量上；
   *    之后如果 pc 又没写对（见 REGNO.PC 那个坑），核就从 ROM 一路跑回应用固件，
   *    现象是"算法永远不结束"。真机标定结果：**plain haltreq 完全够用**，
   *    dmstatus 的 [9:8]（halted）会立刻置起、[11:10]（running）清零。
   *    只有在 haltreq 真的停不住时才退回 reset-halt（少数 DM 需要），见 `_haltByReset()`。
   */
  async halt(hart = 0, timeoutMs = 3000){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq));
    try {
      return await this.waitHalted(timeoutMs);
    } catch (e){
      this.log(` haltreq 没能停住核（${e.message}）→ 退回 reset-halt`);
      return await this._haltByReset(hart, timeoutMs);
    }
  }

  /** reset-halt（兜底）：ndmreset 拉高带 haltreq → 松开 ndmreset（haltreq 保持）*/
  async _haltByReset(hart = 0, timeoutMs = 3000){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.ndmreset | DMCONTROL.haltreq));
    await new Promise(r => setTimeout(r, 50));
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq));
    return await this.waitHalted(timeoutMs);
  }

  /** dmcontrol 的公共位：dmactive + hartsel(h) */
  _ctl(hart, extra = 0){
    return ((DMCONTROL.dmactive | DMCONTROL.hartsel(hart) | extra) >>> 0);
  }

  /**
   * 等核停下来 —— **只轮询，不写 haltreq**。
   * 🚨 烧录算法就是靠"跑完最后一条 ebreak 自然停住"来交差的：这里要是再写一次 haltreq，
   *    会把还在擦/写的算法当场打断，返回码变成垃圾（而界面会显示"成功"或莫名其妙的错误）。
   */
  async waitHalted(timeoutMs = 20000){
    const mask = DMSTATUS.haltedMask(this.dmLayout);
    const t0 = Date.now();
    for (;;){
      const st = await this.dmiRead(DM.DMSTATUS);
      if (st & mask) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等目标 halt 超时（${timeoutMs} ms，dmstatus=0x${st.toString(16)}）`);
    }
  }

  /** 系统复位后运行（烧完让固件自己跑起来）：ndmreset 脉冲 + 不置 haltreq */
  async resetRun(hart = 0){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.ndmreset));
    await new Promise(r => setTimeout(r, 50));
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart));
    await new Promise(r => setTimeout(r, 10));
  }

  /**
   * 实测这台 DM 用哪套 dmstatus 布局（halted 在 [9:8] 还是 [25:24]）。
   * 做法：写一次 haltreq（**不复位**），再看两套布局里哪一对 halted 位被置起来。
   * 真机标定结果（HPM6800EVK, 2026-10）：[9:8] → legacy（0.11 时代排法）。
   */
  async detectLayout(hart = 0){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq));
    const legacyMask = DMSTATUS_LAYOUT.legacy.allhalted | DMSTATUS_LAYOUT.legacy.anyhalted;
    const specMask = DMSTATUS_LAYOUT.spec.allhalted | DMSTATUS_LAYOUT.spec.anyhalted;
    let v = 0;
    for (let i = 0; i < 20; i++){
      v = await this.dmiRead(DM.DMSTATUS);
      if (v & (legacyMask | specMask)) break;
      await new Promise(r => setTimeout(r, 25));
    }
    // 两套布局的 halted 位互不相同：哪一对置起就用哪套（都没置起就按实测的 legacy 来）
    this.dmLayout = (v & legacyMask) ? 'legacy' : (v & specMask) ? 'spec' : 'legacy';
    this.lastDmstatus = v >>> 0;
    this.log(` dmstatus=0x${(v >>> 0).toString(16)} → 用 ${this.dmLayout} 布局判 halt` +
      (this.dmLayout === 'legacy' ? '（halted 在 bit8/9，与 HPM 实测一致）' : '（halted 在 bit24/25，规范布局）'));
    return this.dmLayout;
  }

  /** 让目标跑起来（resumereq），可选先写 pc */
  async resume(pc = null, hart = 0){
    if (pc != null) await this.writeReg(REGNO.PC, pc >>> 0);
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.resumereq));
  }

  /**
   * 跑算法前的准备（**两步都不能省**，都是照 OpenOCD 的 `riscv_run_algorithm` 来的）：
   *   ① `dcsr |= ebreak*`：让算法末尾那条 `ebreak` **进调试模式**而不是触发断点异常。
   *      不置的话核会跳进异常向量乱跑，dmstatus 永远 running；
   *   ② `fence.i`：算法是刚从 SBA 写进 SRAM 的，核的指令预取/缓存里可能是旧内容。
   *      这段 fence 走 **progbuf**（抽象命令 postexec）执行 —— 不能在 SRAM 里跑，
   *      因为"要刷缓存的那段代码"本身就在那儿（鸡生蛋问题）。
   */
  async prepareRun(){
    const dcsr = (await this.readReg(REGNO.DCSR)) >>> 0;
    const want = (dcsr | DCSR_EBREAK.m | DCSR_EBREAK.s | DCSR_EBREAK.u) >>> 0;
    if (want !== dcsr){
      await this.writeReg(REGNO.DCSR, want);
      this.log(` dcsr: 0x${dcsr.toString(16)} → 0x${want.toString(16)}（置 ebreak*，算法收尾的 ebreak 才会停住核）`);
    } else {
      this.log(` dcsr = 0x${dcsr.toString(16)}（ebreak* 已置）`);
    }
    await this.execProgbuf(PROGBUF_FENCE);
    this.log(' 已 fence.i（progbuf 执行，刷指令预取）');
  }

  /**
   * 用 **progbuf** 跑一小段程序（抽象命令 postexec）。程序必须以 `ebreak` 收尾（规范要求）。
   * 这是唯一能在"不执行目标内存里的代码"的前提下让核干点事的手段，用来刷缓存/探 CSR。
   */
  async execProgbuf(words){
    if (!words.length) throw new Error('progbuf 程序不能为空');
    for (let i = 0; i < words.length; i++) await this.dmiWrite(DM.PROGBUF0 + i, words[i] >>> 0);
    const { command } = abstractCommand({ regno: 0x1000, transfer: false, postexec: true, aarsize: 2 });
    await this.dmiWrite(DM.COMMAND, command);
    await this._waitAbstract(3000);
  }

  /** 读一个 hart 寄存器（x0..x31 = 0x1000+n、dpc = 0x7b1）*/
  async readReg(regno){
    const { command } = abstractCommand({ regno, write: false, aarsize: 2 });
    await this.dmiWrite(DM.COMMAND, command);
    await this._waitAbstract();
    return await this.dmiRead(DM.DATA0);          // 通用寄存器、dpc、CSR 都从 data0 取
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

  /**
   * **SBA 健康自检 + 分级自愈** —— 每次"要用 SBA 干正事"（烧录、读 RTT）之前先跑一遍。
   *
   * 2026-10 HPM6800EVK 真机定因：上一次会话（或上一次失败的读）会在系统总线上留下
   * **永远不完成的事务**，此后：
   *   · `sbcs` 里 `sbbusy`(bit21) 常驻、`sbbusyerror`(bit22)/`sberror`([14:12]) 挂着；
   *   · **任何** SBA 访问都失败 —— 烧录的表现是 `SBA 写 0x0 出错`，重试三次也过不去；
   *     读 RTT 的表现是"控制块读回全 0 / 找不到控制块"，用户看到的就是"网页总是卡住"。
   * 分级自愈（从轻到重）：
   *   ① `sbaClearErrors()` —— 能清掉"写 1 清零"的那几个位；
   *   ② DM 复位（`dmcontrol` 写 0 再写 1，即 `init()`）—— 中止挂起操作；
   *   ③ **系统复位（ndmreset）** —— 实测**只有这一级能解开"总线事务卡死"**（`init()` 解不开）。
   *
   * @returns {Promise<{ok:boolean, before:number|null, after:number|null, level:string, note:string}>}
   */
  async sbaHealthCheck({ peekAddr = 0x01200000, perWordMs = 800, allowSystemReset = true } = {}){
    const readSbcs = async () => { try { return (await this.dmiRead(DM.SBCS)) >>> 0; } catch { return null; } };
    /** 脏判据：busy 挂着、或 busyerror/sberror 非 0 */
    const dirty = s => s == null || (s & SBCS.SBBUSY) !== 0 || (s & (SBCS.SBBUSYERROR | SBCS.SBERROR)) !== 0;
    /** 真做一次短超时的 SBA 读 —— sbcs 干净也可能"读一下就卡" */
    const peek = async () => { try { await this.readMem(peekAddr, 4, perWordMs); return true; } catch { return false; } };

    const before = await readSbcs();
    if (!dirty(before) && await peek()){
      return { ok: true, before, after: before, level: 'none', note: 'SBA 干净' };
    }

    // ① 清错误位
    try { await this.sbaClearErrors(); } catch {}
    let after = await readSbcs();
    if (!dirty(after) && await peek()){
      return { ok: true, before, after, level: 'clear', note: '清掉 sberror/sbbusyerror 后恢复' };
    }

    // ② DM 复位（dmcontrol 0 → 1）
    this.log('SBA 不健康 → 复位调试模块（dmcontrol 0→1）');
    try { await this.dmiWrite(DM.DMCONTROL, 0); await this.dmiWrite(DM.DMCONTROL, DMCONTROL.dmactive); } catch {}
    after = await readSbcs();
    if (!dirty(after) && await peek()){
      return { ok: true, before, after, level: 'dm', note: 'DM 复位后恢复' };
    }

    // ③ 系统复位（ndmreset）—— 最后手段，会把目标重启一次
    if (allowSystemReset){
      this.log('SBA 仍不健康 → 系统复位（ndmreset）自愈');
      try { await this.resetRun(); await new Promise(r => setTimeout(r, 1500)); } catch {}
      try { await this.dmiWrite(DM.DMCONTROL, 0); await this.dmiWrite(DM.DMCONTROL, DMCONTROL.dmactive); } catch {}
      after = await readSbcs();
      if (!dirty(after) && await peek()){
        return { ok: true, before, after, level: 'ndmreset', note: '系统复位（ndmreset）后恢复' };
      }
    }
    return { ok: false, before, after, level: 'failed', note: '清错误位 / DM 复位 / ndmreset 都没救回来（多半是接线或目标供电）' };
  }


  /**
   * 一条 USB 命令里塞多拍 DMI 扫描，返回**每条扫描**移出的位（BigInt，低位先出）。
   *
   * 为什么要这个：每拍扫描都是一次 USB 往返（实测 ~0.28 ms），而一次 CMSIS-DAP 的
   * `DAP_JTAG_Sequence` 本来就能装几十拍 —— 逐拍发等于把 USB 延迟乘以拍数。
   * 真机实测（HPM6800EVK）：逐字读 5.7 KB/s，与 TCK 1 MHz 还是 60 MHz 无关 → 瓶颈全在 USB。
   */
  async _scanDRMany(requests){
    const groups = [];
    const all = [];
    for (const rq of requests){
      const seqs = drScan(DR_DMI_BITS, rq, { idle: this.idle });
      groups.push({ from: all.length, n: seqs.length });
      for (const s of seqs) all.push(s);
    }
    const caps = await this.sequences(all);
    const out = [];
    let ci = 0;
    for (const g of groups){
      let v = 0n, bit = 0;
      for (let k = 0; k < g.n && bit < DR_DMI_BITS; k++){
        const s = all[g.from + k];
        if (!s.captureBytes) continue;
        const bytes = caps[ci++];
        const clocks = s.clocks >= 64 ? 64 : s.clocks;
        for (let i = 0; i < clocks && bit < DR_DMI_BITS; i++, bit++){
          if ((bytes[i >> 3] >> (i & 7)) & 1) v |= (1n << BigInt(bit));
        }
      }
      out.push(v);
      this.scans++;
    }
    return out;
  }

  /**
   * 一批 SBA 读：`READ, NOP, READ, NOP, …`（**每拍都收状态**，不是"投一批再收"）。
   *
   * 🚨 为什么不是"READ×N 再收 N 拍"（看着更省）：本文件 `writeMem` 的注释里记着那次教训 ——
   *    DMI 流水线只有一级深，前一条没处理完时投进去的请求会被 DM 回 BSY 并**丢掉**。
   *    读路径虽然丢的是"没读成"而不是"写错地方"，但一旦丢一拍，后面所有字都会**整体错位一个**
   *    （自增是硬件推进的）—— 这种静默错位比慢一点坏得多。所以这里严格照已验证过的逐字时序
   *    （READ 之后必有 NOP 收状态），只是把它们压进**同一条** DAP 命令里省 USB 往返。
   *    任何一拍不是 SUCCESS 就返回 `badAt`，调用方从那里起退回逐字慢路径（并把地址写回去对齐）。
   *
   * @returns {{words:Uint32Array, ok:boolean, badAt:number}} badAt=-1 表示全成功
   */
  async sbaReadBurst(count, perWordMs = 2000){
    const reqs = [];
    for (let i = 0; i < count; i++){
      reqs.push(dmiRequest(DMI_OP.READ, DM.SBDATA0, 0));
      reqs.push(dmiRequest(DMI_OP.NOP, 0, 0));
    }
    const resps = await this._scanDRMany(reqs);
    const words = new Uint32Array(count);
    for (let i = 0; i < count; i++){
      const r = dmiResponse(resps[i * 2 + 1]);          // 第 i 个字的结果在第 i 个 NOP 那拍
      if (r.op !== DMI_STATUS.SUCCESS) return { words, ok: false, badAt: i };
      words[i] = r.data >>> 0;
    }
    return { words, ok: true, badAt: -1 };
  }

  /**
   * 一批能塞几个字？按 CMSIS-DAP 包长算：每拍请求 18 B（TDI 11 + 序列头 7）、响应 6 B，
   * 一个字 = READ + NOP 两拍。留点余量（命令字节 + 固件自己的开销）。
   */
  _burstWords(){
    const pkt = this.dap?.probe?.pkt || this.dap?.pkt || 512;
    const byReq = Math.floor((pkt - 24) / 18 / 2);
    const byResp = Math.floor((pkt - 8) / 6 / 2);
    return Math.max(2, Math.min(12, byReq, byResp));
  }

  /** 查一次 sbcs：攒着的总线错误要当场报出来，别让它变成后一段的错位读 */
  async _checkSbcsAt(here, perWordMs){
    this.lastSbcs = await this.dmiRead(DM.SBCS, perWordMs);
    if (this.lastSbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)){
      this.sbaFailed = true;
      throw new Error(`SBA 读 0x${(here >>> 0).toString(16)} 出错（sbcs=0x${this.lastSbcs.toString(16)}）`);
    }
    if (this.lastSbcs & SBCS.SBBUSY){
      this.sbaFailed = true;
      throw new Error(`SBA 读 0x${(here >>> 0).toString(16)} 时 sbbusy 一直不落 —— 总线事务没完成（地址没映射 / 外设没时钟）`);
    }
  }

  /**
   * 块读：addr 可以不对齐；返回 length 字节。
   *
   * 🚨 出错信息要给得"能直接定位"（2026-10 真机教训）：SBA 去读一个**没映射/没时钟**的
   *    外设窗口时，总线事务可能永远不完成 —— 此时 `sbdata0` 读不出来、`sbbusy` 也一直不落。
   *    这里对每个字都给了上限，并且明确告诉用户"这个地址不对/外设没时钟"，而不是干等。
   *    （SBA 只适合 RAM/已配好的 flash 窗口；片内外设一律走算法/内核去读。）
   */
  async readMem(addr, length, perWordMs = 2000){
    if (length <= 0) return new Uint8Array(0);
    const out = new Uint8Array(length);
    const start = (addr >>> 0) & ~3;
    const first = (addr >>> 0) - start;                 // 头部补齐
    const words = Math.ceil((first + length) / 4);
    await this.sbaConfig();
    this._holdAddr = null;
    await this.dmiWrite(DM.SBADDRESS0, start);
    const put = (i, w) => {
      const b = [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff];
      for (let k = 0; k < 4; k++){
        const pos = i * 4 + k - first;
        if (pos >= 0 && pos < length) out[pos] = b[k];
      }
    };

    /**
     * 两条路：
     *   · **批量**（默认）：一批十几个字压进**一条** DAP_JTAG_Sequence 命令；
     *   · **逐字**（保底）：原来看过真机的那套写法 —— 批次出错、或目标就是批不动时退回来。
     *
     * 🚨 批量那条**每拍都验状态**（见 `sbaReadBurst`）：DMI 流水线只有一级深，丢一拍不会报错，
     *    只会让后面所有字**整体错位一个**（自增在硬件里推进）。所以任何一拍不是 SUCCESS，
     *    就从那个字起退回逐字，并且**把 sbaddress0 写回去对齐**（不重写就不知道自增停在哪）。
     *    另外"批不动"不算错误（逐字照样读得全，只是慢）：连撞 3 次就整段不再批。
     */
    const BURST = this._burstWords();
    let i = 0, slowLeft = 0;
    while (i < words){
      const want = Math.min(BURST, words - i);
      if (!this._burstOff && slowLeft <= 0 && want >= 2){
        const b = await this.sbaReadBurst(want, perWordMs);
        const good = b.ok ? want : Math.max(0, b.badAt);
        for (let k = 0; k < good; k++) put(i + k, b.words[k]);
        i += good;
        if (b.ok){
          /**
           * sbcs 检查**不必每批都做**：查一次 = 两次 DMI 扫描（= 两条 USB 命令），
           * 每批都查会把命令数翻三倍（实测 512 个字 133 条 → 改成每 4 批查一次后 ~50 条）。
           * 批次内部的"每拍验状态"已经能抓住丢拍，这里只是兜底看有没有攒着的总线错误。
           */
          if (i % (BURST * 4) === 0 || i === words) await this._checkSbcsAt(start + (i - 1) * 4, perWordMs);
          continue;
        }
        this._burstMiss++;
        if (this._burstMiss >= 3) this._burstOff = true;
        await this.dmiWrite(DM.SBADDRESS0, (start + i * 4) >>> 0);
        slowLeft = BURST;
        continue;
      }
      const here = (start + i * 4) >>> 0;
      let w;
      try {
        w = await this.dmiRead(DM.SBDATA0, perWordMs);
      } catch (e){
        this.sbaFailed = true;
        throw new Error(`SBA 读 0x${here.toString(16)} 卡住了（${e.message}）——` +
          ' 这个地址多半没映射，或所在外设的时钟被门控（片内外设请让内核去读）');
      }
      put(i, w);
      i++;
      if (slowLeft > 0) slowLeft--;
      // 逐字路径每 16 个字查一次 sbcs（真机实测：逐字查会把读放大一倍）
      if (slowLeft <= 0 && (i % 16 === 0 || i === words)) await this._checkSbcsAt(here, perWordMs);
    }
    return out;
  }

  /** 块写：addr 必须 4 字节对齐、length 必须是 4 的倍数（flashloader 的 buf 就是这么用的）*/
  async writeMem(addr, bytes){
    if (bytes.length % 4) throw new Error(`SBA 写要求 4 字节对齐（长度 ${bytes.length}）`);
    if ((addr >>> 0) % 4) throw new Error(`SBA 写要求 4 字节对齐（地址 0x${(addr >>> 0).toString(16)}）`);
    // 🚨 写路径的 sbcs **不能带 sbreadonaddr**：否则写地址会先触发一次读、读完自增 4，
    //    第一笔数据就落到 addr+4（真机上表现为"blob 整体错位一个字"，接下去 resume 跑垃圾指令）
    await this.sbaConfig(sbcsWrite());
    this._holdAddr = null;
    await this.dmiWrite(DM.SBADDRESS0, addr >>> 0);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /**
     * 🚨 **每个字都要收一次状态，不许"投一批再收"**（2026-10 真机教训，我自己踩的）：
     *    DMI 流水线只有一级深 —— 前一条请求还没处理完时投进去的那条，DM 会回 **BUSY 并把它丢掉**。
     *    我为了省扫描，曾把这里改成"每 64 个字收一次 NOP"，结果用户板子上 blob 写进 SRAM 时丢了字，
     *    `flash_init` 跑的是残缺代码 → **卡死**（我这边时序恰好没触发，所以自测没抓到）。
     *    正确写法就是 `dmiWrite`（写 + NOP 收状态）逐个来；省下来的那点时间不值得拿正确性换。
     *    （`setup()` 里另有一道"写完读回校验"，这类问题以后会当场报错而不是表现成卡死。）
     */
    for (let off = 0; off < bytes.length; off += 4){
      await this.dmiWrite(DM.SBDATA0, dv.getUint32(off, true));
    }
    // 收尾：读一次 sbcs 确认没有攒着的错误
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
