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
    /**
     * 🚨 **别每读一个字就查一次 `sbcs`**（2026-10 提速）：
     *    查一次 = 两次 DMI 扫描，和"读一个字"本身一样贵 —— 逐字查等于把读放大一倍。
     *    改成每 `pollEvery` 个字查一次（并保留逐字的墙钟上限），错误照样抓得住
     *    （64 个字 = 256 B，出错时仍然报得出大致位置），真机实测读回快约一倍。
     */
    const pollEvery = 64;
    for (let i = 0; i < words; i++){
      const here = (start + i * 4) >>> 0;
      let w;
      try {
        w = await this.dmiRead(DM.SBDATA0, perWordMs);
      } catch (e){
        this.sbaFailed = true;
        throw new Error(`SBA 读 0x${here.toString(16)} 卡住了（${e.message}）——` +
          ' 这个地址多半没映射，或所在外设的时钟被门控（片内外设请让内核去读）');
      }
      const last = (i === words - 1);
      if (last || (i % pollEvery) === pollEvery - 1){
        this.lastSbcs = await this.dmiRead(DM.SBCS, perWordMs);
        if (this.lastSbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)){
          this.sbaFailed = true;
          throw new Error(`SBA 读 0x${here.toString(16)} 出错（sbcs=0x${this.lastSbcs.toString(16)}）`);
        }
        if (this.lastSbcs & SBCS.SBBUSY){
          this.sbaFailed = true;
          throw new Error(`SBA 读 0x${here.toString(16)} 时 sbbusy 一直不落 —— 总线事务没完成（地址没映射 / 外设没时钟）`);
        }
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
