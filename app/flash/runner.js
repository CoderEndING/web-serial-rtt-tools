/**
 * flashloader 执行器：把 algos.js 里的算法放进目标 RAM 跑起来，完成擦/写。
 *
 * 原理（pyOCD/dapjs 同款做法）：
 *   ① halt 目标 → 算法代码写进 RAM（load_address）；
 *   ② 设寄存器（xPSR.T / SP / PC / r0-r2）→ 让 CPU 跑 → 算法末尾的 BKPT 会自己停回来；
 *   ③ 轮询 DHCSR.S_HALT，读 r0 当返回值（0 = 成功）。
 * 寄存器访问走 CoreSight 调试寄存器：DCRSR 选寄存器 + DCRDR 读写（都是内存映射地址，
 * 用现成的 readMem/writeMem 就能碰）。
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function b64ToBytes(b64){
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class FlashRunner {
  constructor(probe){ this.probe = probe; }

  // ---------- 寄存器 ----------
  // 读写都委托给 probe（AP1 上的 DCRSR/DCRDR 握手在 dap-webusb.regRead/regWrite 里做，
  // 包括 S_REGRDY 等待 —— DHCSR 的 bit16，读的时候取字节 2 的 bit0）

  // ---------- 算法 ----------
  /** halt + 算法载入 RAM + pc_init（r0=flash 基址） */
  async load(algo){
    this.algo = algo;
    this.code = b64ToBytes(algo.code);
    const p = this.probe;
    await p.halt();
    // 🚨 先摁住中断再擦：第一个被擦的扇区就是向量表，中断一旦进来内核就 LOCKUP
    if (p.maskInterrupts) await p.maskInterrupts();
    await p.writeMem(algo.load_address, this.code);
    await this.runCode(algo.pc_init, { 0: algo.flash_start, 1: 0, 2: 0 }, 10000);
  }

  /** 设寄存器并执行到 BKPT；r0 必须为 0（ARM flash 算法约定：0 = SUCCESS） */
  async runCode(entry, args = {}, timeoutMs = 10000){
    const p = this.probe;
    await p.halt();
    /**
     * 🚨 顺序要紧：**PC 必须最后写**。
     *    写 DCRSR 到 PC(regsel 15) 的语义是"分支到新地址"，某些内核实现会**立刻从新 PC 开始执行**；
     *    先写 PC 再写 r0-r2，参数就丢在运行中写了（算法拿到垃圾参数 → 永远不返回 BKPT →
     *    表现为「flashloader 执行超时」）。pyOCD 也是参数先写、PC 最后写。
     */
    await p.regWrite(16, 0x01000000);                // xPSR：T 位（Thumb），其余清零
    /**
     * 🚨 LR 必须指向**算法 blob 开头的 BKPT**（= load_address | 1），不能图省事写 0xFFFFFFFE。
     *    ARM/pyOCD 的 flashloader 约定：算法函数都是 `bx lr` 收尾，而 blob 第 0 条指令就是
     *    `BKPT 0x0000` —— "返回" 到那里 = 内核 halt，主机poll S_HALT 就知道算法跑完了。
     *    写 0xFFFFFFFE 的后果：算法 `bx lr` 跳飞 → HardFault → 掉进固件的 HardFault 死循环，
     *    核心**永远不 halt**，主机只能超时报「flashloader 执行超时」（本机实测踩到）。
     */
    await p.regWrite(14, (this.algo.load_address | 1) >>> 0);   // LR → blob 开头的 BKPT
    await p.regWrite(13, this.algo.begin_stack);     // SP
    for (const n of Object.keys(args)) await p.regWrite(Number(n), args[n] >>> 0);   // r0-r2 等参数
    await p.regWrite(15, entry >>> 0);               // PC 最后写（写它就会跳过去执行）
    await p.run();
    const t0 = Date.now();
    while (!(await p.isHalted())){
      if (Date.now() - t0 > timeoutMs){
        const pc = await p.regRead(15).catch(() => 0);
        throw new Error(`flashloader 执行超时（入口 0x${entry.toString(16)}，停在 pc=0x${pc.toString(16)}）—— 算法与芯片/RAM 地址不匹配？`);
      }
      await sleep(5);
    }
    const r0 = await p.regRead(0);
    if (r0 !== 0) throw new Error(`flashloader 返回错误码 ${r0}（入口 0x${entry.toString(16)}）—— 擦写失败或地址/参数不对`);
    return r0;
  }

  async eraseSector(addr){ await this.runCode(this.algo.pc_erase_sector, { 0: addr }, 30000); }
  async eraseAll(){ await this.runCode(this.algo.pc_eraseAll, { 0: this.algo.flash_start }, 180000); }

  /** 数据先写进 RAM 缓冲，再调 program_page（r0=目标地址 r1=长度 r2=缓冲地址） */
  async programPage(addr, data){
    const buf = this.algo.page_buffers[0];
    await this.probe.writeMem(buf, data);
    // 🚨 写完之后**必须把这笔 posted 写逼落地**再让算法去读它：
    //    AP 的写是后发的，算法在目标侧直接读 RAM，抢在前面就会读到上一页的内容 →
    //    烧进去的是旧数据（实测现象：校验失败，某个字节对不上）。
    if (this.probe.flushWrites) await this.probe.flushWrites();
    await this.runCode(this.algo.pc_program_page, { 0: addr, 1: data.length, 2: buf }, 30000);
  }

  /** 单次编程块大小：页参数与缓冲容量取小（缓冲容量 = 两缓冲间距或到栈底的余量） */
  chunkSize(){
    const a = this.algo;
    const room = a.page_buffers.length > 1
      ? a.page_buffers[1] - a.page_buffers[0]
      : Math.max(256, Math.min(a.page_size, a.begin_stack - a.page_buffers[0]));
    return Math.min(a.page_size, room);
  }
}
