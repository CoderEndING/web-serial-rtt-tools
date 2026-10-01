/**
 * HPM 系列（RISC-V）WebUSB 烧录流程 —— 把 flashloader 搬进目标 SRAM 再驱动它。
 *
 * 与 ARM 那边的 flashloader 是同一套思路（`app/flash/runner.js` + `algos.js`），差别只在"怎么调"：
 *   ARM：写 DHCSR 停核、写 DCRSR/DCRDR 传参、靠 BKPT 停住；
 *   RISC-V：抽象命令写 a0..a4、写 dpc 当 pc、resume 之后**轮询 dmstatus.allhalted**
 *           （算法最后一条是 ebreak → 硬件 halt），返回码在 a0。
 *
 * 🚨 轮询 halt 时**不能**再写 haltreq：那会把还在跑的算法当场打断（返回码就永远是垃圾）。
 *
 * 算法 blob 的来源与入口表语义见 `tools/target-firmware/hpm_flash_algo/README.md`；
 * 一块 1.4 KB 的 blob 通吃 HPM 全系（ROM API 表地址全系相同）。
 */

import { HPM_ALGO, hpmAlgoBytes } from './algo.js';
import { algoEntries } from './entry.js';
import { HPM_COMMON, hpmInitArgs, hpmCheckRange } from './chips.js';

/** flashloader 调用 ROM API 的返回码（`hpm_stat_t`，只列常见的）*/
export const HPM_STATUS = {
  0: '成功',
  1: '参数无效（invalid argument）',
  2: '地址/长度越界（out of range）',
  3: '超时（timeout）',
  4: '没找到 flash（no flash）',
  5: 'flash 未初始化',
  6: '扇区被保护',
  101: 'XPI 未初始化',
};
export const hpmStatusText = c => HPM_STATUS[c >>> 0] || `未知状态 0x${(c >>> 0).toString(16)}`;

export class HpmFlasher {
  /**
   * @param {import('./riscv-dm.js').RiscvTransport} dm 已经 init 过的传输层
   * @param {{board:object, log?:Function, chunkBytes?:number, onProgress?:Function}} opts
   */
  constructor(dm, opts){
    if (!opts?.board) throw new Error('HpmFlasher 需要 board（见 chips.js 的 HPM_BOARDS）');
    this.dm = dm;
    this.board = opts.board;
    this.log = opts.log || (() => {});
    this.onProgress = opts.onProgress || (() => {});
    this.chunkBytes = opts.chunkBytes ?? 4096;
    this.scratchInfo = 0x1000;          // flash_get_info 的输出（8 B）
    this.dataBuf = 0x2000;              // 编程数据中转区（RAM）
    this.inited = false;
    this.entries = null;
    this.chipInfo = null;
  }

  /** 把算法写进 SRAM 并调 flash_init + flash_get_info（拿到芯片回报的真实容量/扇区）*/
  async setup(){
    const bytes = hpmAlgoBytes();
    const parsed = algoEntries(bytes);
    if (parsed.count < 7){
      throw new Error(`flashloader 入口表只认出 ${parsed.count} 个入口（期望 7）—— blob 不对？`);
    }
    this.entries = parsed.byName;
    for (const name of ['init', 'erase', 'program', 'read', 'info', 'eraseChip', 'deinit']){
      if (!this.entries[name]) throw new Error(`flashloader 缺少入口 ${name}`);
    }
    if (bytes.length > HPM_COMMON.workAreaSize - this.dataBuf){
      throw new Error(`算法 ${bytes.length} B + 数据区放不进 ${HPM_COMMON.workAreaSize / 1024} KB 的 work area`);
    }
    this.log(`准备 flashloader：${bytes.length} B（入口 7 个，偏移 ` +
      Object.entries(this.entries).map(([k, v]) => `${k}+0x${v.entryOffset.toString(16)}`).join(' ') + '）');
    await this.dm.writeMem(HPM_ALGO.loadAddr, bytes);
    this.log(`写完 flashloader：${bytes.length} B → SRAM 0x${HPM_ALGO.loadAddr.toString(16)}`);

    /**
     * 🚨 **写完立刻读回校验**（2026-10 真机教训）：SBA 写丢字（例如 DMI 忙时被丢掉的那条写）
     *    不会报错，只会让核跑一段残缺代码 —— 表现是"加载完 flashloader 就卡住"，
     *    排查起来极费劲（用户看到的只是转圈）。1388 B 读回约 0.2 s，换一个**当场能看懂的报错**很值。
     */
    const back = await this.dm.readMem(HPM_ALGO.loadAddr, bytes.length);
    let badAt = -1;
    for (let i = 0; i < bytes.length; i++) if (back[i] !== bytes[i]){ badAt = i; break; }
    if (badAt >= 0){
      throw new Error(`flashloader 写进 SRAM 后读回不一致（第 ${badAt} 字节：写 0x${bytes[badAt].toString(16)}、` +
        `读回 0x${back[badAt].toString(16)}）—— SBA 写丢了数据，别继续跑（会卡死）。` +
        ' 常见原因：探针/目标被别的会话抢占（另一个标签页的 RTT 转发、RTT Viewer）、USB 线材或供电不稳。' +
        ' 先关掉其他会话、拔插一次探针再试');
    }

    const a = hpmInitArgs(this.board, { 0: HPM_ALGO.headerWords0, 1: HPM_ALGO.headerWords1, 2: HPM_ALGO.headerWords2 });
    let rc = await this.call('init', [a.flashBase, a.header, a.option0, a.option1, a.xpiBase]);
    if (rc) throw new Error(`flash_init 失败：${hpmStatusText(rc)}` +
      `（base=0x${a.flashBase.toString(16)} xpi=0x${a.xpiBase.toString(16)} opt0=0x${a.option0.toString(16)} opt1=0x${a.option1.toString(16)}）`);

    rc = await this.call('info', [a.flashBase, this.scratchInfo]);
    if (rc) throw new Error(`flash_get_info 失败：${hpmStatusText(rc)}`);
    const info = await this.dm.readMem(this.scratchInfo, 8);
    const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
    this.chipInfo = { totalBytes: dv.getUint32(0, true), sectorBytes: dv.getUint32(4, true) };
    if (!this.chipInfo.totalBytes || !this.chipInfo.sectorBytes){
      throw new Error(`flashloader 回报的容量不合理（总 ${this.chipInfo.totalBytes} B / 扇区 ${this.chipInfo.sectorBytes} B）——` +
        ' 多半是 XPI 没配起来（option0/1 或 xpi_base 与板子不符）');
    }
    this.inited = true;
    this.log(`flashloader 就绪：总容量 ${(this.chipInfo.totalBytes / 1048576).toFixed(2)} MB · 扇区 ${this.chipInfo.sectorBytes} B`);
    return this.chipInfo;
  }

  /**
   * 调一个入口：写 a0..a4 → 写 pc → resume → 等 halt → 读 a0。
   *
   * 🚨 2026-10 用户现场（线上页点「烧录」卡在"加载 flashloader"转圈，**而且把板子扔在核跑飞状态**
   *    —— 之后 ping 都不通，看起来像板子坏了）：
   *    算法末尾那条 `ebreak` 没回来（`waitHalted` 超时），旧代码直接抛错走人，
   *    核还在跑那半截代码/垃圾指令。现在：
   *      · **第 1 次没回来就地自愈再跑一次**（强行 halt → 复位 DM → 重装算法镜像并读回校验 →
   *        重新置 `dcsr.ebreak*` + `fence.i`）—— 这条 JTAG/SBA 通路偶发丢拍，"重来一次就过"是常态；
   *      · 两次都不过才抛错，并且由调用方（`view.js`）兜底做一次 `recoverAfterFailure()` 别让核飞着。
   */
  async call(entry, args = [], timeoutMs = 20000){
    const e = this.entries[entry];
    if (!e) throw new Error(`没有入口 ${entry}`);
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++){
      try {
        // 参数放 a0..a4（x10..x14）
        for (let i = 0; i < args.length; i++) await this.dm.writeReg(0x1000 + 10 + i, args[i] >>> 0);
        // 🚨 跑之前必须：置 dcsr.ebreak*（否则收尾的 ebreak 变成异常，核跑飞）+ fence.i（刚写进去的代码）
        await this.dm.prepareRun();
        await this.dm.resume((HPM_ALGO.loadAddr + e.entryOffset) >>> 0);
        await this.dm.waitHalted(timeoutMs);
        return (await this.dm.readReg(0x1000 + 10)) >>> 0;
      } catch (err){
        lastErr = err;
        if (attempt === 2 || !/halt 超时/.test(String(err?.message || ''))) throw err;
        this.log(`⚠ 算法 ${entry} 第 1 次没回来（${err.message}）→ 强行停核 + 复位 DM + 重装算法，再来一次`);
        await this.recoverCore();
      }
    }
    throw lastErr;
  }

  /**
   * 核跑飞之后的现场恢复：`haltreq` 停住 → 复位 DM（dmactive 0→1）→ 重新 halt →
   * 把算法镜像**再写一遍并读回校验**（DMI 丢字 / 指令预取拿到旧内容都靠这步兜住）。
   */
  async recoverCore(){
    const bytes = hpmAlgoBytes();
    try { await this.dm.halt(0, 3000); } catch { /* 停不住也继续往下试 */ }
    try { await this.dm.init(); } catch { /* DM 复位失败就让后面的读去报错 */ }
    await this.dm.activate(0);
    await this.dm.halt(0, 3000);
    await this.dm.writeMem(HPM_ALGO.loadAddr, bytes);
    const back = await this.dm.readMem(HPM_ALGO.loadAddr, bytes.length);
    for (let i = 0; i < bytes.length; i++){
      if (back[i] !== bytes[i]){
        throw new Error(`恢复时重写算法仍不一致（第 ${i} 字节：写 0x${bytes[i].toString(16)}、读回 0x${back[i].toString(16)}）` +
          ' —— 探针↔目标链路不稳，建议拔插一次探针/给板子断电重上电再烧');
      }
    }
    this.log('   已恢复现场（核已停、DM 已复位、算法镜像已重写并校验）');
  }

  /**
   * **失败收尾**：烧录中途失败时调用，尽量别把核扔在"跑飞"状态
   * （用户看到的会是"板子 ping 不通了、像坏了"，实际只是核在跑垃圾）。
   */
  async recoverAfterFailure(){
    try { await this.dm.halt(0, 2000); } catch { /* 停不住就算了 */ }
    try { await this.dm.resetRun(); } catch { /* 复位失败也认了 */ }
  }

  /**
   * 擦除 [addr, addr+len)：算法内部按扇区/块自己安排。
   *
   * 🚨 **传给算法的是"偏移"，不是绝对地址**（2026-10 真机定标）：
   *    算法里 `flash_erase/program/read` 只在 `ROMAPI_SUPPORTS_HYBRIDXPI()`
   *    （ROM API 版本 ≥ 0x56010300）时才做 `address += flash_base`；HPM6800EVK 这版 ROM
   *    不是 hybrid，所以 `address` 必须**相对 XPI 窗口**（0x80000000 起算的偏移）。
   *    实测：传绝对地址 0x80000000 → `rc=2`（out of range）；传偏移 → 擦/写/读全部 rc=0。
   *    对外的 API 仍然用绝对地址（好看、好和芯片规格对照），在调用点换算。
   */
  async erase(addr, len){
    const chk = hpmCheckRange(this.board, addr, len);
    if (!chk.ok) throw new Error('擦除范围不合法：' + chk.why);
    if (!this.inited) throw new Error('先 setup()');
    const rc = await this.call('erase', [this.board.flashBase, this.offsetOf(addr), len >>> 0], 60000);
    if (rc) throw new Error(`flash_erase 失败：${hpmStatusText(rc)}`);
    this.log(`已擦除 0x${addr.toString(16)} 起 ${len} B`);
  }

  /** 绝对地址 → 算法要的偏移（XPI 窗口内）*/
  offsetOf(addr){
    const off = ((addr >>> 0) - (this.board.flashBase >>> 0)) >>> 0;
    if (off >= (this.board.flashSize >>> 0)) throw new Error(`地址 0x${(addr >>> 0).toString(16)} 不在 flash 窗口内`);
    return off;
  }

  /** 烧写：分块写进 RAM 中转区 → flash_program */
  async program(addr, data){
    if (!this.inited) throw new Error('先 setup()');
    const chk = hpmCheckRange(this.board, addr, data.length);
    if (!chk.ok) throw new Error('烧写范围不合法：' + chk.why);
    const total = data.length;
    for (let off = 0; off < total; off += this.chunkBytes){
      const n = Math.min(this.chunkBytes, total - off);
      const chunk = data.subarray(off, off + n);
      // 中转区必须 4 字节对齐、长度补到 4 的倍数（算法按字写 flash）
      const padded = new Uint8Array(Math.ceil(n / 4) * 4).fill(0xff);
      padded.set(chunk);
      await this.dm.writeMem(this.dataBuf, padded);
      const rc = await this.call('program', [this.board.flashBase, this.offsetOf(addr + off), this.dataBuf, padded.length], 60000);
      if (rc) throw new Error(`flash_program 在 0x${(addr + off).toString(16)} 失败：${hpmStatusText(rc)}` +
        (rc === 1 ? '（该地址不是已擦除状态？先擦除，或地址落在别的 flash 窗口）' : ''));
      this.onProgress((off + n) / total, off + n, total);
    }
  }

  /**
   * 校验：用算法的 `flash_read` 把 flash 读回 RAM 再逐字节比。
   * （不走 0x80000000 的 XIP 映射：XPI 可能还没配成可读，而 flash_read 走 ROM API 一定可用。）
   */
  async verify(addr, data){
    if (!this.inited) throw new Error('先 setup()');
    let bad = -1, firstBad = null;
    for (let off = 0; off < data.length; off += this.chunkBytes){
      const n = Math.min(this.chunkBytes, data.length - off);
      const padded = Math.ceil(n / 4) * 4;
      const rc = await this.call('read', [this.board.flashBase, this.dataBuf, this.offsetOf(addr + off), padded], 60000);
      if (rc) throw new Error(`flash_read 在 0x${(addr + off).toString(16)} 失败：${hpmStatusText(rc)}`);
      const back = await this.dm.readMem(this.dataBuf, padded);
      for (let i = 0; i < n; i++){
        if (back[i] !== data[off + i]){
          if (bad < 0){ bad = off + i; firstBad = { expect: data[off + i], got: back[i] }; }
        }
      }
      this.onProgress((off + n) / data.length, off + n, data.length, true);
    }
    if (bad >= 0){
      throw new Error(`校验失败：0x${(addr + bad).toString(16)} 读到 0x${firstBad.got.toString(16)}，` +
        `期望 0x${firstBad.expect.toString(16)}`);
    }
    return true;
  }

  /** 收尾：flash_deinit + 让目标从 flash 启动（系统复位）*/
  async finish({ run = true } = {}){
    try { await this.call('deinit', [], 3000); } catch { /* 收尾失败不影响结果 */ }
    if (run) await this.dm.resetRun();
  }

  /** 一步到位：擦 → 写 → 校验（可选） */
  async flashImage(addr, data, { verify = true, erase = true } = {}){
    await this.setup();
    if (erase) await this.erase(addr, data.length);
    await this.program(addr, data);
    if (verify) await this.verify(addr, data);
    return { addr, bytes: data.length, verified: verify };
  }
}
