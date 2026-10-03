/**
 * RTT Viewer 的 **RISC-V/JTAG 零安装通路**：让 RTT Viewer 也能连 RISC-V 目标（HPM 等）。
 *
 * 为什么能这么"简单"：Viewer 上层的 `Rtt`（`app/rtt/protocol.js`）**只依赖两个方法** ——
 *   `mem.readMem(addr, len)` / `mem.writeMem(addr, bytes)`。
 * ARM 那条路是 `WebUsbDapProbe` 自己在浏览器里做 ADIv5/AHB-AP；RISC-V 这边换一套：
 *   **HID（0xFF00）切 output_mode = SWD+JTAG → WebUSB 走 CMSIS-DAP 的 DAP_JTAG_Sequence
 *     → RISC-V DMI → SBA（系统总线）读内存** —— 这套现成的引擎就是烧录页用的
 *   `app/flash/hpm/{dap-transport,riscv-dm}.js`，这里只负责"开门 + 收尾"。
 *
 * 与 ARM 那条路的**关键差别**（2026-10 真机实测，别踩）：
 *   ① 探针必须先切 `output_mode = SWD+JTAG`（HID CMD_SET_CONFIG）**并且每次都要发**：
 *      只读回来看是 1 也没用，TDI/TDO 还被 VCOM 占着时 `DAP_Connect(JTAG)` 会返回 DISABLED。
 *   ② 还要让探针**自己的 RISC-V 引擎**和**探针侧 RTT 桥**放开 TAP（HID 0x33 action 0 / 0x31 action 0），
 *      否则它们一直占着 JTAG，`DAP_Connect(2)` 拿不到口。
 *   ③ `WebUsbDapProbe.open` 必须 `skipTargetInit: true`：默认那套按 **SWD** 协商时钟
 *      （DAP_Connect(SWD)+SWD_Configure+读 IDCODE），RISC-V 目标会一路 SWD NO ACK。
 *   ④ **SBA 读不走 D-cache 旁路**：变量放在可缓存区时读到的是陈旧值 ——
 *      RTT 控制块必须由固件放在**非缓存**内存（HPM 上通常是 AXI SRAM 0x01240000 一带）。
 */
import { AkaLinkHid } from '../hid/probe.js';
import { WebUsbDapProbe, withTimeout } from './dap-webusb.js';
import { DapJtagTransport, setOutputModeData, PROBE_OUTPUT_MODE } from '../flash/hpm/dap-transport.js';
import { RiscvTransport } from '../flash/hpm/riscv-dm.js';
import { HPM_COMMON } from '../flash/hpm/chips.js';

/**
 * Viewer 侧要的 `mem` 形状（`Rtt` 只用这两个方法 + 界面上那几个可选钩子）。
 * 另外补几个 `probe` 习惯用法，让 `rtt/view.js` 里那些 `this.probe?.xxx?.()` 优雅降级：
 * 不提供 `run/isHalted/reset`（那是 Cortex-M 的 DHCSR 语义），界面据此把按钮关掉。
 */
export class RiscvMem {
  constructor({ probe, jtag, dm, clockKhz = 0, log = () => {}, perWordMs = 700 }){
    this.probe = probe;
    this.jtag = jtag;
    this.dm = dm;
    this.clockKhz = clockKhz;
    this.perWordMs = perWordMs;      // 单字读的墙钟上限（正常 ~0.2 ms；给 700 ms 已经很宽松）
    this.log = log;
    this.name = `RISC-V/JTAG · SBA ${clockKhz ? clockKhz / 1000 + 'MHz' : ''}`.trim();
    /** 不是 Cortex-M：没有 halt/run/DHCSR，"快速档"也不适用（保持 false，界面不会去切它）*/
    this.fast = false;
    this.isRiscv = true;
    /**
     * 🚨 **别去读 RTT 的通道名**（`protocol.js` 的 `name()` 会看这个标志跳过）。
     *
     * 通道名是目标内存里的一个指针（`sName`），固件把它放在哪不受我们控制 —— HPM6800EVK 的
     * flood/scope 靶子都放在 **XIP flash（0x8000cf1c）**，而 SBA 读那个窗口**会永久挂起**：
     * 读请求发出去就不回来，`sbbusy` 一直不落，**整条链路跟着不应答**。
     *
     * 真机现场（2026-10，`make hw-campaign-hpm`）就是被它拖死的：
     *   · 首次轮询里夹着这次读 → 撞 1.2 s 超时（`name()` 的保护）→ 超时后那笔事务仍挂着，
     *     下一次 SBA 访问把 `sbcs.sbbusyerror` 置起来（实测 0x4c0ca2 = 只有 bit22）
     *     → 后续每个环读都直接失败（状态栏“SBA 读 0x12410e4 出错”）；
     *   · 就算侥幸没脏，SDK 的 1.2 s + DM 复位 + 叫醒 DM 那一串也要 ~2 s，全被算进
     *     “Viewer 速率”的计时窗口里（实测 8 s 窗口里 0 次轮询 → 判决 0.0 KB/s）。
     * 名字只是锦上添花，ARM 那条路（AHB-AP 读 flash 没问题）照旧读，RISC-V 这边直接不读。
     */
    this.skipNames = true;
  }

  readMem(addr, len){ return this._read(addr, len); }
  writeMem(addr, bytes){ return this.dm.writeMem(addr, bytes); }

  /**
   * 读内存（带"一次恢复 + 重试"）。
   *
   * 🚨 真机踩到（2026-10，HPM6800EVK）：**SBA 去读某些窗口会永久挂起**（事务不完成、sbbusy 不落），
   *    而且挂起之后**整条链路都不应答** —— 表现出来不是"这个地址读不到"，而是"Viewer 连上以后
   *    一个字节都不来"。本例的具体触发点是 RTT 通道的 `sName` 指向 **XIP flash**（0x8000cf1c）：
   *    控制块在 SRAM 里读得好好的，一读那个字符串就整条链路卡住（`Rtt.name()` 于是永远不返回）。
   *    解药在 `riscv-dm.js` 里写着：把 `dmcontrol` 先写 0 再写 1（DM 复位）能中止挂起的 SBA 事务。
   *    所以这里：**单字超时压短**（正常一个字 ~0.2 ms，700 ms 足够），失败就复位 DM 重试一次。
   */
  async _read(addr, len){
    try {
      return await this.dm.readMem(addr, len, this.perWordMs);
    } catch (e){
      if (this._recovering) throw e;
      this._recovering = true;
      try {
        this.log(`读 0x${(addr >>> 0).toString(16)}（${len} B）失败：${e.message} —— 清 SBA 错误 + 复位 DM 后重试一次`);
        /**
         * 🚨 顺序有讲究（2026-10 HPM6800EVK 现场）：超时/挂起会在 `sbcs` 里留下 **sticky**
         *    的 `sbbusyerror`（写 1 才清），而这个标志会让**之后每一次** SBA 访问立刻失败
         *    （现象：Viewer 连上、控制块也定位到了，第一个环读就永久报
         *    “SBA 读 0x… 出错（sbcs=0x4c0ca2）”，`polls` 卡在 1）。
         *    实测：只 `dm.init()`（dmcontrol 0→1）不清它，先 `sbaClearErrors()` 再重试立刻就好
         *    （`dm.init()` 仍然要做 —— 挂起的事务要靠它中止）。
         */
        try { await this.dm.sbaClearErrors(); } catch {}
        await this.dm.init();
        return await this.dm.readMem(addr, len, this.perWordMs);
      } finally {
        this._recovering = false;
      }
    }
  }

  /** 错位读/卡住时的自救：重新把链路开一遍（TAP 复位 + DM 唤醒），不重开 USB */
  async recover(){
    try { await this.dm.sbaClearErrors(); } catch {}
    const r = await this.dm.init();
    this.log(`RISC-V 链路已重置：idcode=0x${Number(r?.idcode || 0).toString(16)}`);
    return r;
  }

  async disconnect(){
    try { await this.dm?.sbaClearErrors(); } catch {}
    try { await this.probe?.disconnect(); } catch {}
  }

  info(){
    return {
      kind: 'riscv',
      idcode: this.dm?.idcode,
      dmstatus: this.dm?.lastDmstatus,
      sbcs: this.dm?.lastSbcs,
      scans: this.dm?.scans,
      clockKhz: this.clockKhz,
    };
  }
}

/**
 * 开一条 RISC-V 内存通路。**会先停掉探针侧的 RTT 桥与 RISC-V 引擎**（它们占着 TAP 与目标内存），
 * 所以调用本函数前别指望"转发页还在跑"。
 *
 * @param {{log?:Function, clockKhz?:number, all?:boolean, timeoutMs?:number}} [opts]
 * @returns {Promise<RiscvMem>}
 */
export async function openRiscvMem(opts = {}){
  const log = opts.log || (() => {});
  const timeoutMs = opts.timeoutMs ?? 20000;

  // ① 探针：HID 切 SWD+JTAG 输出模式，并把两个"占 TAP 的家伙"停掉
  const hid = new AkaLinkHid();
  try {
    await withTimeout(hid.reconnect(), 8000, '连探针 HID');
    await withTimeout(hid.xfer(0x02 /* CMD_SET_CONFIG */, setOutputModeData(PROBE_OUTPUT_MODE.SWD_JTAG)), 3000, '切输出模式');
    log('探针 output_mode = SWD+JTAG');
  } catch (e){
    // 没 HID 也别立刻放弃：可能只是浏览器没授权 HID —— 后面 DAP_Connect(JTAG) 会给出更准确的判据
    log('⚠ 切 output_mode 失败（继续试 JTAG）：' + (e?.message || e));
  }
  try { await withTimeout(hid.riscvStop(), 2000, 'RISC-V 引擎 stop'); log('已让探针 RISC-V 引擎放开 TAP（0x33 action 0）'); }
  catch { log('（0x33 stop 没响应，可能本来就空闲）'); }
  try { await withTimeout(hid.stop(), 2500, 'RTT 桥 stop'); log('已停掉探针侧 RTT 桥（0x31 action 0）—— 它和本页读同一个 RTT 环'); }
  catch { log('（RTT 桥 stop 没响应，可能本来就没跑）'); }
  try { await hid.close(); } catch {}

  // ② WebUSB：认领 interface 0，**不做 SWD 目标初始化**
  const auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针');
  const openOpts = { skipTargetInit: true };
  const probe = auth.length
    ? await withTimeout(WebUsbDapProbe.open(auth[0], openOpts), timeoutMs, '连接探针（WebUSB）')
    : await withTimeout(WebUsbDapProbe.request(!!opts.all, openOpts), 60000, '等你在浏览器里选探针');
  probe.onLog = s => log('[usb] ' + s);

  const clockKhz = Number(opts.clockKhz) || 0;
  try {
    if (clockKhz > 0){
      /**
       * ⚠️ 这里的时钟是 **DAP_SWJ_Clock（真正的 TCK 频率）**，跟 HID 0x31 action 7 那个
       *    `clockHz` 字段**不是一回事** —— 后者在 JTAG 下是 DMI 的 idle/delay 覆盖值，
       *    塞大数字进去会让探针读不到目标内存（见 app/hid/view.js 的注释），必须留 0。
       */
      await probe.setClock(clockKhz * 1000);
      log(`JTAG TCK = ${clockKhz / 1000} MHz（DAP_SWJ_Clock）`);
    }
    const jtag = new DapJtagTransport(probe, { irLength: HPM_COMMON.irLength, log });
    const dm = new RiscvTransport(jtag, { idle: 8, log });
    const info = await withTimeout(dm.init(), timeoutMs, '初始化 RISC-V 调试模块');
    log(`RISC-V 就绪：idcode=0x${Number(info.idcode).toString(16)} dmstatus=0x${Number(info.dmstatus).toString(16)}`);
    /**
     * 🚨 初始化完先做一次 **SBA 健康检查**（三级自愈：清错 → 复位 DM → 必要时 ndmreset）。
     *
     * 为什么必须在这里做：`sbcs` 的错误位是**写 1 才清**的 sticky 位，而且它会跨会话留下 ——
     * 上一格（烧录、或者上一次 RTT Viewer/J-Scope 会话被中途打断）留下的 `sbbusyerror`
     * 会让**本次会话的第一个环读就永久失败**：现象是 Viewer 连上了、控制块也定位到了，
     * 但 `polls` 卡在 1、`bytes=0`，状态栏 "SBA 读 0x… 出错（sbcs=0x400ca2）"。
     * 实测（2026-10，make hw-campaign-hpm 第 2 轮）：光靠读到失败后再自愈不够稳 ——
     * 有时候 `sbaClearErrors()` + `dm.init()` 也解不开（DMI 流水线已经错位），
     * 得让健康检查走到 ndmreset 那一级。放在连接阶段做，代价是几十毫秒，收益是整轮不白跑。
     */
    let health = null;
    try {
      health = await withTimeout(dm.sbaHealthCheck({ peekAddr: 0x01200000 }), 15000, 'SBA 健康检查');
      if (health) log(`SBA 健康检查：${JSON.stringify(health)}`);
    } catch (e){
      log('⚠ SBA 健康检查没做完（继续试）：' + (e?.message || e));
    }
    const mem = new RiscvMem({ probe, jtag, dm, clockKhz, log });
    /* 健康检查结果留给上层（编排脚本靠 health.slow 判断"是不是该重开 USB 会话"） */
    mem.health = health;
    return mem;
  } catch (e){
    try { await probe.disconnect(); } catch {}
    throw e;
  }
}
