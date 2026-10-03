/**
 * 数据面传输：把"512 B 包流"从探针搬到页面。两种实现**同形**，页面不用管用的是哪个：
 *   · `VendorEpTransport` —— 真家伙：WebUSB 认领 interface 0，走**空闲的 bulk IN 端点 0x83**
 *     （SWO 端点，固件里从没写过；见 docs/scope-page.md §4）。
 *   · `MockTransport`      —— 假探针：不需要硬件，波形确定性生成（自测/演示用）。
 *
 * 收流的两条纪律（都是踩过的坑换来的）：
 *  1. **保持多条 transferIn 在飞**：一条 USB 读一次往返 ~0.2~0.5 ms，串行读会把速率锁死在
 *     几百 KB/s；批量读 4 KB + 2~4 条在飞才能吃满 bulk 带宽。
 *  2. **收尾必须先停推流、再收干净**：WebUSB 没有取消接口（app/rtt/dap-webusb.js:39-49 记着
 *     这个坑），挂起的 transferIn 会偷走下一场的响应 —— 所以 stop() 里要等在飞的读自己回来。
 */
import { MockScopeProbe } from './mock.js';

/** 探针上那个空闲的 bulk IN 端点（SWO 端点，SWO_STREAM=0 所以没人用）*/
export const EP_SCOPE = 0x83;
const VID = 0x0d28;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class VendorEpTransport {
  constructor(device, opts = {}){
    this.device = device;
    this.ep = EP_SCOPE;
    this.iface = 0;
    this.chunkBytes = opts.chunkBytes ?? 4096;   // 一次 transferIn 想收多少（会被短包提前结束）
    this.inFlight = opts.inFlight ?? 3;          // 同时在飞的读
    this.running = false;
    this.workers = [];
    this.gen = 0;                 // 收流"轮次"代号：stop() 一加，超时残留在飞的 worker 就作废
    this.stalledInFlight = 0;     // 上一轮 stop() 里 800 ms 没等回来的在飞读笔数
    this.onError = null;          // 数据面不可恢复时的回调（由 start() 传入）
    this._fatal = null;
    this.chunks = 0; this.bytes = 0; this.errors = 0; this.lastError = null;
  }

  static supported(){ return typeof navigator !== 'undefined' && !!navigator.usb; }

  /** 已授权过的探针（浏览器记得就不用再弹框）*/
  static async authorized(){
    if (!VendorEpTransport.supported()) return [];
    try { return (await navigator.usb.getDevices()).filter(d => d.vendorId === VID); } catch { return []; }
  }

  /** 弹设备框 → 打开 → 认领接口（注意：必须给浏览器一个可见窗口，否则 requestDevice 直接回空数组）*/
  static async request(opts = {}){
    if (!VendorEpTransport.supported()) throw new Error('这个浏览器没有 WebUSB（桌面版 Chrome / Edge 才有）');
    const d = await navigator.usb.requestDevice({ filters: [{ vendorId: VID }] });
    const t = new VendorEpTransport(d, opts);
    await t.open();
    return t;
  }

  get label(){
    const d = this.device;
    const addr = (this.epAddr || (this.ep | 0x80)).toString(16);
    return `${d?.productName || 'akaLinkPro'} · EP 0x${addr} · ${this.chunkBytes} B/读 × ${this.inFlight}`;
  }

  /** 打开设备、找到带 0x83 的那个接口并认领 */
  async open(){
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    let found = null;
    for (const iface of d.configuration.interfaces){
      for (const alt of iface.alternates){
        /**
         * 🚨 Chrome 的 WebUSB 报的 `endpointNumber` **不含方向位**：
         *    描述符里的 `0x83`（IN EP3）这里读出来是 `3`、`0x02`（OUT EP2）是 `2`、
         *    `0x81`（IN EP1）是 `1`。第一版按 `=== 0x83` 找，真机上永远找不到
         *    （"这个设备没有 bulk IN 端点 0x83"）—— 只有上真机才会暴露，假探针测不出来。
         *    而 `transferIn(ep)` / `clearHalt('in', ep)` 收的也是**这个不带方向位的编号**
         *    （既有的 CMSIS-DAP 通路就是这么用的，所以它一直好使）。
         */
        const ep = (alt.endpoints || []).find(e =>
          e.endpointNumber === (EP_SCOPE & 0x7f) && e.type === 'bulk' && e.direction === 'in');
        if (ep){ found = { iface, ep }; break; }
      }
      if (found) break;
    }
    if (!found){
      const seen = d.configuration.interfaces.flatMap(i => i.alternates.flatMap(a =>
        (a.endpoints || []).map(e => `0x${(e.endpointNumber | (e.direction === 'in' ? 0x80 : 0)).toString(16)}/${e.type}`)));
      throw new Error('没找到 bulk IN 端点 0x83（SWO 端点）—— 旧固件？选错设备了？' +
        `这个设备暴露的端点：${seen.join(' ') || '(无)'}`);
    }
    this.iface = found.iface.interfaceNumber;
    this.ep = found.ep.endpointNumber;         // 注意：不带方向位的编号（0x83 → 3）
    this.epAddr = this.ep | 0x80;              // 描述符里的地址，只用于显示/排障
    this.claimed = false;
    try { await d.claimInterface(this.iface); this.claimed = true; }
    catch (e){
      /**
       * 🚨 **先端口复位再试一次**（2026-10 用户现场反复遇到）：
       *    `Unable to claim interface` 绝大多数是**残留占用**（上一次会话没放干净、
       *    页面被刷新掉、脚本中途退出、别的进程开过），不是接线问题。
       *    `device.reset()` 能把接口状态清干净，之后通常一把就成 —— 用户点一次「连接数据端点」
       *    就该连上，而不是被要求去排查一堆东西。
       */
      let ok = false;
      try {
        await d.reset();
        await sleep(250);
        await d.claimInterface(this.iface);
        ok = true; this.claimed = true;
        console.warn('[scope] 认领接口失败 → 端口复位后重试成功');
      } catch { /* 落到下面报错 */ }
      if (!ok){
        throw new Error(`认领 USB 接口失败：${e.message}\n` +
          '一个 USB 接口同时只能被一个程序/页签占用 —— 请检查：\n' +
          '  · 是不是**另开了一个页签**连着同一个数据端点？\n' +
          '  · 本工具的 RTT Viewer / 烧录器页还开着？\n' +
          '  · OpenOCD / pyOCD / J-Link 之类的本机程序还没退出？\n' +
          '（已经试过自动端口复位重连；再不行就拔插一次探针）');
      }
    }
    // 认领后清一次端点：上一场会话（或上一次断开）可能残留数据
    try { await d.clearHalt('in', this.ep); } catch { /* 有的设备不支持，忽略 */ }
    return this;
  }

  /**
   * 开始收流（onChunk 会被持续调用，参数是**原始字节**）。
   * @param {(bytes:Uint8Array)=>void} onChunk
   * @param {(e:Error)=>void} [onError] 数据面**不可恢复**地停了（读异常 / 反复 STALL）时叫一次 ——
   *        页面据此停采集并提示。以前没有这条回调：worker 悄悄退出、`running` 还是 true、
   *        界面照旧显示"采样中"，而一个字节都不来（2026-10 代码审查）。
   */
  async start(onChunk, onError){
    if (this.running) return;
    this.running = true;
    this._fatal = null;
    this.onError = typeof onError === 'function' ? onError : null;
    this.gen++;                                   // 新一轮的代号：上一轮没收干净的 worker 靠它作废
    this.chunks = 0; this.bytes = 0; this.errors = 0;
    const g = this.gen;
    this.workers = Array.from({ length: this.inFlight }, () => this._worker(onChunk, g));
  }

  /** 数据面出事 → 停掉整条流，并把原因交给页面（只报一次：N 条 worker 会同时撞上）*/
  _fail(why){
    if (this._fatal) return;
    this._fatal = why;
    this.errors++; this.lastError = why;
    this.running = false;
    try { this.onError?.(new Error(why)); } catch { /* 页面自己出错不该拖垮这里 */ }
  }

  async _worker(onChunk, g){
    let stalls = 0;
    /**
     * 🚨 循环条件要带上**代号** `g`：`stop()` 等在飞的读回来最多 800 ms，超时的那一条会活到
     *    下一轮 —— 那时 `running` 又被 `start()` 置回 true，只判 running 的话它会"复活"继续收，
     *    而且已经不在 `workers` 里，后面的 `stop()` 再也等不到它（worker 数无界增长，2026-10 代码审查）。
     */
    while (this.running && g === this.gen){
      let r;
      try {
        r = await this.device.transferIn(this.ep, this.chunkBytes);
      } catch (e){
        /* 读抛异常（USB 抖动、探针复位）以前是直接 break —— 几条 worker 全退出后数据面就停了，
         * 而 `running` 还是 true、页面还显示"采样中"（2026-10 代码审查）。现在上报并整体停下。 */
        if (this.running && g === this.gen){
          this._fail('数据流中断：' + (e?.message || String(e)) + '（探针掉线了？拔插一次，或改用假探针）');
        }
        break;
      }
      if (!this.running || g !== this.gen) break;     // 收尾 / 换轮：这一条读到了也不再用
      if (r.status === 'ok' && r.data?.byteLength){
        stalls = 0;
        this.chunks++; this.bytes += r.data.byteLength;
        onChunk(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      } else if (r.status !== 'ok'){
        this.errors++; this.lastError = r.status;
        if (r.status === 'stall'){
          /**
           * 🚨 STALL 必须 `clearHalt` 才解得开。老代码只给 errors 加一就立刻回头再读 ——
           *    端点一直保持 STALL，于是**空转**（实测 100 ms 内 transferIn 调了 7 万次）、
           *    CPU 占满、数据一个都不来（2026-10 代码审查）。这里清一次、让一拍，
           *    连续解不开就把整条流停掉并如实报出来，别让页面傻等。
           */
          try { await this.device.clearHalt('in', this.ep); } catch { /* 有的平台不支持 */ }
          await sleep(10);
          if (++stalls >= 8){
            this._fail(`端点 0x${(this.ep | 0x80).toString(16)} 连续 ${stalls} 次 STALL，clearHalt 也解不开 —— 数据流已停`);
            break;
          }
        }
      }
    }
  }

  /** 停止收流：等在飞的读全部回来（最多 800 ms），**不要**让它们挂在那儿 */
  async stop(){
    this.gen++;                    // 代号一变，超时残留在飞的那条读回来后就自行作废
    if (!this.running){ this.workers = []; this.stalledInFlight = 0; return; }
    this.running = false;
    let settled = 0;
    const all = this.workers.map(p => p.then(() => { settled++; }, () => { settled++; }));
    await Promise.race([Promise.allSettled(all), sleep(800)]);
    this.workers = [];
    /** 800 ms 还没回来的在飞读有几笔（WebUSB 取消不掉，只能如实记账；页面可据此提示）*/
    this.stalledInFlight = Math.max(0, all.length - settled);
  }

  async close(){
    await this.stop();
    try { if (this.device?.opened) await this.device.close(); } catch { /* 忽略 */ }
  }
}

/** 假传输：包源是 MockScopeProbe 的 poll()，时间用 performance.now()
 *  ⚠️ 允许注入 `probe` —— 页面里 HID 面（配置/启停）和数据面必须是**同一个** mock 实例，
 *     否则会出现"配置发给了 A、数据从 B 出来"这种自己骗自己的假象。 */
export class MockTransport {
  constructor(opts = {}){
    this.probe = opts.probe || new MockScopeProbe(opts);
    this.running = false;
    this.timer = null;
    this.chunks = 0; this.bytes = 0; this.errors = 0; this.lastError = null;
    this.rateCap = opts.pollMs ?? 20;      // 每 20 ms 收一次（模拟 USB 轮询节奏）
    this._t0 = null;
  }
  static supported(){ return true; }
  static async request(opts){ return new MockTransport(opts); }
  get label(){ return `假探针（无需硬件）· ${Math.round(1e6 / this.probe.periodUs / 1000)} kHz · ${this.probe.vars.length} 通道`; }
  get device(){ return null; }
  /** 与真传输同形：真的那个要 open() 认领接口，假的什么都不用做 */
  async open(){ return this; }
  async start(onChunk){
    if (this.running) return;
    this.running = true;
    this._t0 = performance.now();
    this.probe.poll(0);
    this.timer = setInterval(() => {
      if (!this.running) return;
      const nowUs = (performance.now() - this._t0) * 1000;
      const out = this.probe.poll(nowUs);
      for (const pkt of out){ this.chunks++; this.bytes += pkt.length; onChunk(pkt); }
    }, this.rateCap);
  }
  async stop(){
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer); this.timer = null;
    await sleep(30);
  }
  async close(){ await this.stop(); }
}
