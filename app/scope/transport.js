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
       * 🚨 一个 USB 接口同一时刻只能被一个"认领者"持有。最常见的冲突来源：
       *    · 你在**另一个浏览器页签**里也连了这个数据端点（同一台机器上最常见）；
       *    · 本仓库的 RTT Viewer 页 / 烧录器页正开着探针；
       *    · OpenOCD / pyOCD / J-Link 那些本机程序还没退。
       * 提示里要把这三条都点出来，不然用户只会看到一句"无法认领接口"。
       */
      throw new Error(`认领 USB 接口失败：${e.message}\n` +
        '一个 USB 接口同时只能被一个程序/页签占用 —— 请检查：\n' +
        '  · 是不是**另开了一个页签**连着同一个数据端点？\n' +
        '  · 本工具的 RTT Viewer / 烧录器页还开着？\n' +
        '  · OpenOCD / pyOCD / J-Link 之类的本机程序还没退出？');
    }
    // 认领后清一次端点：上一场会话（或上一次断开）可能残留数据
    try { await d.clearHalt('in', this.ep); } catch { /* 有的设备不支持，忽略 */ }
    return this;
  }

  /** 开始收流（onChunk 会被持续调用，参数是**原始字节**）*/
  async start(onChunk){
    if (this.running) return;
    this.running = true;
    this.chunks = 0; this.bytes = 0; this.errors = 0;
    this.workers = Array.from({ length: this.inFlight }, () => this._worker(onChunk));
  }

  async _worker(onChunk){
    while (this.running){
      let r;
      try {
        r = await this.device.transferIn(this.ep, this.chunkBytes);
      } catch (e){
        if (this.running){ this.errors++; this.lastError = e?.message || String(e); }
        break;
      }
      if (!this.running) break;                       // 收尾：这一条读到了也不再用
      if (r.status === 'ok' && r.data?.byteLength){
        this.chunks++; this.bytes += r.data.byteLength;
        onChunk(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      } else if (r.status !== 'ok'){
        this.errors++; this.lastError = r.status;
      }
    }
  }

  /** 停止收流：等在飞的读全部回来（最多 800 ms），**不要**让它们挂在那儿 */
  async stop(){
    if (!this.running) return;
    this.running = false;
    await Promise.race([Promise.allSettled(this.workers), sleep(800)]);
    this.workers = [];
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
