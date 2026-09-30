/**
 * 数据面（bulk）—— 两种实现**同形**，页面里只差一个对象：
 *   · `WebUsbSpiTransport` —— 真家伙：WebUSB 认领那个 vendor 接口（class 0xFF、EP11 双向），
 *     OUT 0x0B 发帧、IN 0x8B 收应答。
 *   · `MockSpiTransport`   —— 假探针：把包交给 `MockSpiProbe` 执行，应答从它的队列里取。
 *
 * 三条纪律（都是踩过的坑）：
 *  1. **一帧不跨包**：调用方用 protocol.packFrames() 切好的包，这里只负责发；
 *     一次 send() = 一个包；**一次 sendRaw() = 一次 transferOut**，可以带攒批后的多个包
 *     （固件仍按 512 B 槽解析，见 protocol.batchPacks 的注释）。
 *  2. **保持多条 IN 在飞**：一条 USB 读一次往返 0.2~0.5 ms，串行读会把速率锁死。
 *  3. **收尾要先停发、再等在飞读写回来**：WebUSB 没有取消接口（见 app/scope/transport.js 的说明），
 *     挂起的读会偷走下一场的应答。
 *
 * 接口发现的两个坑（`#scope` 页真机踩过，这里同样适用）：
 *  · Chrome 报的 `endpointNumber` **不含方向位**：0x8B → 11/'in'、0x0B → 11/'out' —— 同一个号两个方向。
 *  · 同一个设备上有**两个 class 0xFF 的接口**（这个是 SPI 桥，另一个是 WebUSB 平台接口，0 个端点），
 *    所以判据是"class 0xFF 且 bulk EP11 双向都有"，不能只看 class。
 */
import { EP_NUM, PKT, BATCH_MAX, batchPacks } from './protocol.js';
import { yieldTask, sleep } from '../core/pace.js';

const VID = 0x0d28;

export class WebUsbSpiTransport {
  constructor(device, opts = {}){
    this.device = device;
    this.chunkBytes = opts.chunkBytes ?? 4096;
    this.inFlight = opts.inFlight ?? 4;        // IN 读（收应答）
    this.outInFlight = opts.outInFlight ?? 8;  // OUT 写（发帧）—— 刷屏吞吐的关键，见 sendPacks。
                                               // 实测 8 与 16 同档（均受主机侧每帧开销限制），8 对固件 OUT 环压力更小
    this.outTimeoutMs = opts.outTimeoutMs ?? 2000;
    this.iface = null; this.epIn = null; this.epOut = null;
    this.running = false;
    this.workers = [];
    this.writes = 0; this.writeBytes = 0; this.reads = 0; this.readBytes = 0;
    this.errors = 0; this.lastError = null; this.dirty = false;
  }

  static supported(){ return typeof navigator !== 'undefined' && !!navigator.usb; }

  /** 已授权过的探针（浏览器记得就不用再弹框）*/
  static async authorized(){
    if (!WebUsbSpiTransport.supported()) return [];
    try { return (await navigator.usb.getDevices()).filter(d => d.vendorId === VID); } catch { return []; }
  }

  /** 弹设备框 → 打开 → 认领 interface（必须给浏览器一个可见窗口，否则 requestDevice 直接回空）*/
  static async request(opts = {}){
    if (!WebUsbSpiTransport.supported()) throw new Error('这个浏览器没有 WebUSB（桌面版 Chrome / Edge 才有）');
    const d = await navigator.usb.requestDevice({ filters: [{ vendorId: VID }] });
    const t = new WebUsbSpiTransport(d, opts);
    await t.open();
    return t;
  }

  get label(){
    const d = this.device;
    if (!d) return '';
    return `${d.productName || 'akaLinkPro'} · SPI 桥接口 ${this.iface ?? '?'} · EP 0x${(this.epOut || 0).toString(16)}/0x${((this.epIn || 0) | 0x80).toString(16)}`;
  }

  /** 找到并认领带 EP11 双向 bulk 的 vendor 接口 */
  async open(){
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);

    let found = null, seen = [];
    for (const iface of d.configuration.interfaces){
      for (const alt of iface.alternates){
        const eps = alt.endpoints || [];
        seen = seen.concat(eps.map(e => `0x${(e.endpointNumber | (e.direction === 'in' ? 0x80 : 0)).toString(16)}/${e.type}@if${iface.interfaceNumber}`));
        const epIn = eps.find(e => e.endpointNumber === EP_NUM && e.direction === 'in' && e.type === 'bulk');
        const epOut = eps.find(e => e.endpointNumber === EP_NUM && e.direction === 'out' && e.type === 'bulk');
        if (epIn && epOut && !found) found = { iface, epIn, epOut };
      }
    }
    if (!found){
      throw new Error('这个设备没有 SPI 桥接口（vendor 接口 + EP11 双向 bulk）。\n' +
        '最常见的原因：**板子上烧的是 akaLinkPro 产品固件** —— SPI 桥只在 HPM5301EVKLite 构建里编译\n' +
        '（firmware/application_5301/boards/*/board.h 的 BOARD_HAS_SPI_BRIDGE）。\n' +
        `设备实际暴露的端点：${seen.join(' ') || '(无)'}`);
    }
    this.iface = found.iface.interfaceNumber;
    this.epIn = found.epIn.endpointNumber;      // 不带方向位的编号（0x8B → 11）
    this.epOut = found.epOut.endpointNumber;    // 同上（0x0B → 11）
    this.claimed = false;
    try { await d.claimInterface(this.iface); this.claimed = true; }
    catch (e){
      // 先端口复位再试一次（"Unable to claim interface" 十有八九是残留占用，不是接线）
      let ok = false;
      try { await d.reset(); await sleep(250); await d.claimInterface(this.iface); ok = true; this.claimed = true; }
      catch { /* 落到下面报错 */ }
      if (!ok){
        throw new Error(`认领 USB 接口失败：${e.message}\n` +
          '一个 USB 接口同时只能被一个程序/页签占用 —— 检查：别的页签、烧录器页、OpenOCD/pyOCD/J-Link。\n' +
          '（已经试过自动端口复位重连；再不行就拔插一次探针）');
      }
    }
    try { await d.clearHalt('in', this.epIn); } catch { /* 有的设备不支持，忽略 */ }
    try { await d.clearHalt('out', this.epOut); } catch { /* 同上 */ }
    return this;
  }

  /** 开始收应答（onRsp 收到的是**原始字节块**，切包交给上层 / RspStream）*/
  async start(onRsp){
    if (this.running) return;
    this.running = true;
    this.workers = Array.from({ length: this.inFlight }, () => this._readWorker(onRsp));
  }

  async _readWorker(onRsp){
    while (this.running){
      let r;
      try { r = await this.device.transferIn(this.epIn, this.chunkBytes); }
      catch (e){
        if (this.running){ this.errors++; this.lastError = e?.message || String(e); this.dirty = true; }
        break;
      }
      if (!this.running) break;                       // 收尾：这一条读到了也不再用
      if (r.status === 'ok' && r.data?.byteLength){
        this.reads++; this.readBytes += r.data.byteLength;
        onRsp(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      } else if (r.status !== 'ok'){
        this.errors++; this.lastError = r.status;
      }
    }
  }

  /** 发一个包（≤ PKT）。返回实际写出的字节数；超时/失败抛错并标脏设备 */
  async send(pack, timeoutMs = this.outTimeoutMs){
    const data = pack instanceof Uint8Array ? pack : new Uint8Array(pack);
    if (data.length > PKT) throw new Error(`一个包不能超过 ${PKT} B（固件按包解析）`);
    return this.sendRaw(data, timeoutMs);
  }

  /**
   * 发**一次传输**（URB）—— 可以是攒批后的多个 512 B 包（见 `batchPacks` 的注释：
   * 固件仍按 512 B 槽解析，所以包序列不变，只是主机少喊几次）。
   */
  async sendRaw(buf, timeoutMs = this.outTimeoutMs){
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!data.length) return 0;
    if (data.length > BATCH_MAX) throw new Error(`一次传输 ${data.length} B 超过上限 ${BATCH_MAX} B`);
    let timer = null;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => { this.dirty = true; rej(new Error(`写超时（${timeoutMs} ms）—— 桥没使能？OUT 环满？`)); }, timeoutMs);
    });
    try {
      const r = await Promise.race([this.device.transferOut(this.epOut, data), timeout]);
      if (r.status !== 'ok'){ this.errors++; this.lastError = r.status; throw new Error(`transferOut 状态 ${r.status}`); }
      this.writes++; this.writeBytes += r.bytesWritten ?? data.length;
      return r.bytesWritten ?? data.length;
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * 发一批包。**按 `batchBytes` 攒批提交，并保持 `outInFlight` 批在飞**：
   *
   *   · `batchBytes = PKT`（默认）= 每包一次 transferOut，与老行为**完全等价**；
   *   · 攒批（一帧的量级）：一帧 290 个包 → 10 次提交，把主机侧每次调用 ~150 µs 的固定开销
   *     从 44 ms/帧 压到 ~2 ms/帧 —— 60 MHz 单线刷一帧只要 18.9 ms，帧率瓶颈就还给了 SPI/固件侧。
   *
   * ⚠️ 顺序仍然有保证：USB 同一端点上的传输按**提交顺序**入队（FIFO），
   *    而 CS_HOLD 的管道化刷屏依赖顺序 —— 所以这里只在**同一条端点**上并发提交，不改顺序。
   */
  async sendPacks(packs, opts = {}){
    const { onProgress, stopOnError = false, shouldStop, timeoutMs = this.outTimeoutMs,
            concurrency = this.outInFlight, batchBytes = PKT } = opts;
    const batches = batchPacks(packs, batchBytes);
    const total = packs.length;
    let next = 0, sent = 0, failed = 0, firstErr = null, stopped = false;
    const worker = async () => {
      for (;;){
        if (stopped || shouldStop?.()) return;
        const i = next++;
        if (i >= batches.length) return;
        const b = batches[i];
        try {
          await this.sendRaw(b.data, timeoutMs);
          sent += b.packs;
        } catch (e){
          failed += b.packs;
          this.lastError = e?.message || String(e);
          if (!firstErr) firstErr = e;
          if (stopOnError){ stopped = true; return; }
        }
        onProgress?.(sent + failed, total, i);
      }
    };
    const n = Math.max(1, Math.min(concurrency, batches.length || 1));
    await Promise.all(Array.from({ length: n }, worker));
    if (firstErr && stopOnError) throw firstErr;
    return { sent, failed, total, batches: batches.length, calls: this.writes };
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

/**
 * 假传输：同一个 `MockSpiProbe` 既当 HID 控制面又当帧执行器。
 * ⚠️ 允许从外面注入 `probe` —— 页面里 HID 面与数据面**必须**是同一个实例。
 */
export class MockSpiTransport {
  constructor(opts = {}){
    this.probe = opts.probe || null;
    if (!this.probe) throw new Error('MockSpiTransport 需要一个 MockSpiProbe（HID 与数据面必须同一个实例）');
    this.running = false;
    this.timer = null;
    this.tickMs = opts.tickMs ?? 3;
    this.writes = 0; this.writeBytes = 0; this.reads = 0; this.readBytes = 0;
    this.errors = 0; this.lastError = null;
    this.dirty = false;
    this._delay = opts.latencyMs ?? 0;
  }
  static supported(){ return true; }
  static async request(opts){ return new MockSpiTransport(opts); }
  get label(){ return `假探针（无需硬件）· 档位 ${this.probe.profile.profile} · ${this.probe.cfg.sclkHz ? (this.probe.cfg.sclkHz / 1e6) + ' MHz' : '板级默认'}`; }
  get device(){ return null; }
  async open(){ return this; }
  async start(onRsp){
    if (this.running) return;
    this.running = true;
    this.onRsp = onRsp;
    const pump = async () => {
      if (!this.running) return;
      this.probe.tick();
      await this._drain();
      this.timer = setTimeout(pump, this.tickMs);
    };
    pump();
  }
  /**
   * 把假探针里攒着的应答交给上层。
   * 🚨 **每写一个包就排空一次**：真设备那边是"一边写 OUT、一边有几条 IN 读在飞"，
   * 应答是边走边取的；只在定时器里排的话，一个 34 帧的批量读会瞬间灌满假探针的
   * 16 槽 IN 环、把先到的应答挤掉 —— 于是"读测速"在假探针上假失败（真机上不会）。
   */
  async _drain(){
    let rsp;
    while ((rsp = this.probe.takeRsp())){
      if (this._delay) await sleep(this._delay);
      this.reads++; this.readBytes += rsp.length;
      this.onRsp?.(rsp);
    }
  }
  async send(pack){
    const data = pack instanceof Uint8Array ? pack : new Uint8Array(pack);
    if (data.length > PKT) throw new Error(`一个包不能超过 ${PKT} B`);
    return this.sendRaw(data);
  }

  /** 攒批后的一次传输：假探针自己按 512 B 槽拆开（与真固件的 `usbd_ep_start_read(..., 512)` 同口径）*/
  async sendRaw(buf){
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (data.length > BATCH_MAX) throw new Error(`一次传输 ${data.length} B 超过上限 ${BATCH_MAX} B`);
    this.writes++; this.writeBytes += data.length;
    const r = this.probe.write(data);
    if (!r.accepted){ this.errors++; this.lastError = '桥没使能（真固件这里会 NAK）'; throw new Error(this.lastError); }
    await this._drain();
    return data.length;
  }

  async sendPacks(packs, opts = {}){
    const { onProgress, stopOnError = false, shouldStop, batchBytes = PKT } = opts;
    const batches = batchPacks(packs, batchBytes);
    let sent = 0, failed = 0;
    for (let i = 0; i < batches.length; i++){
      if (shouldStop?.()) break;
      try { await this.sendRaw(batches[i].data); sent += batches[i].packs; }   // sent 只数成功的，与 WebUsbSpiTransport 同口径
      catch (e){ failed += batches[i].packs; this.lastError = e?.message || String(e); if (stopOnError) throw e; }
      onProgress?.(sent + failed, packs.length, i);
      if ((i & 7) === 7) await yieldTask();
    }
    return { sent, failed, total: packs.length, batches: batches.length, calls: this.writes };
  }
  async stop(){
    if (!this.running) return;
    this.running = false;
    if (this.timer){ clearTimeout(this.timer); this.timer = null; }
    await sleep(10);
  }
  async close(){ await this.stop(); }
}
