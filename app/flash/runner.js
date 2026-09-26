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
    await p.writeMem(algo.load_address, this.code);
    await this.runCode(algo.pc_init, { 0: algo.flash_start, 1: 0, 2: 0 }, 10000);
  }

  /** 设寄存器并执行到 BKPT；r0 必须为 0（ARM flash 算法约定：0 = SUCCESS） */
  async runCode(entry, args = {}, timeoutMs = 10000){
    const p = this.probe;
    await p.halt();
    await p.regWrite(16, 0x01000000);                // xPSR：T 位（Thumb），其余清零
    await p.regWrite(14, 0xfffffffe);                // LR
    await p.regWrite(13, this.algo.begin_stack);     // SP
    await p.regWrite(15, entry >>> 0);               // PC
    for (const n of Object.keys(args)) await p.regWrite(Number(n), args[n] >>> 0);
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
