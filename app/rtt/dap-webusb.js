/**
 * WebUSB + CMSIS-DAP v2（bulk）探针 —— 零安装的 RTT 通路。
 *
 * 只依赖标准 CMSIS-DAP，不认识 J-Link（J-Link 协议不开放，网页接不上）。
 * 命令/响应格式与 ESP32-S31 自制探针 cherrydap 的 DAP.c 逐条核对过：
 *   · 响应第一个字节 = 命令回显（DAP_ProcessCommand 里 *response++ = *request）
 *   · DAP_Transfer 每条传输在请求里固定占 5 字节（1 请求字节 + 4 字节 data），读也要占位
 *   · DAP_TransferBlock 响应 = [回显, count_lo, count_hi, ack, data...]
 *   · DAP_ResetTarget 响应 = [回显, DAP_OK, 执行标志]
 */
import { u32le, u32leBytes } from '../core/bin.js';

export const CMD = {
  Info: 0x00, Connect: 0x02, Disconnect: 0x03, TransferConfigure: 0x04,
  Transfer: 0x05, TransferBlock: 0x06, WriteABORT: 0x08, Delay: 0x09,
  ResetTarget: 0x0a, SWJ_Pins: 0x10, SWJ_Clock: 0x11, SWJ_Sequence: 0x12, SWD_Configure: 0x13,
};
const X_APnDP = 0x01, X_RnW = 0x02, X_ADDR = 0x0c;
const AP_CSW = 0x00, AP_TAR = 0x04, AP_DRW = 0x0c;
const DP_IDCODE = 0x00, DP_CTRL_STAT = 0x04, DP_SELECT = 0x08, DP_RDBUFF = 0x0c;
const SWJ_nRESET = 1 << 7;
const ACK = { 1: 'OK', 2: 'WAIT', 4: 'FAULT', 7: 'NO ACK' };
const reqByte = (ap, rnw, addr) => (ap ? X_APnDP : 0) | (rnw ? X_RnW : 0) | (addr & X_ADDR);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withTimeout(p, ms, what){
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} 超时（${ms}ms）：探针没响应`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

export class WebUsbDapProbe {
  constructor(){
    this.name = 'CMSIS-DAP';
    this.device = null;
    this.pkt = 64;
    this.iface = 0;
    this.epIn = 0;
    this.epOut = 0;
    this.maxWords = 12;
    this._ready = false;
    this.lastError = null;
    this.clockHz = 1_000_000;          // 当前生效的 SWD 时钟（握手成功后 = 实际请求值）
    this.clockTried = [];              // 试过哪些档位（排障用）
  }

  /**
   * SWD 时钟档位（kHz）：逐档试，第一个能读到合法 IDCODE 的就用。
   *
   * 🚨 **不是越高越快**：本机 MicroLink CMSIS-DAP + STM32F103 实测（RTT 阻塞发数据、
   *    目标侧对账一致）：1 MHz 114 KB/s、4 MHz 236、**8 MHz 330（最快）**、
   *    10 MHz 324、12 MHz 254、20/30 MHz 只有 250 左右 —— 所以 8 MHz 排在第一个。
   *    时钟太高还会读到错数据（对账对不上）或直接 NO ACK，必须逐档回退。
   *    想手工指定用界面上的「SWD 时钟」下拉框（存 rtt.clockKhz）。
   */
  static CLOCK_CANDIDATES = [8000, 12000, 4000, 2000, 1000, 500, 200];

  static supported(){ return typeof navigator !== 'undefined' && 'usb' in navigator; }

  static async authorized(){
    if (!WebUsbDapProbe.supported()) return [];
    try { return await navigator.usb.getDevices(); } catch { return []; }
  }

  /** 弹浏览器设备选择框；all=true 时列出所有 USB 设备（非 DAPLink 也能试） */
  static async request(all = false, opts = {}){
    if (!WebUsbDapProbe.supported()) throw new Error('这个浏览器没有 WebUSB（请用桌面版 Chrome / Edge）');
    const device = await navigator.usb.requestDevice({ filters: all ? [] : [{ vendorId: 0x0d28 }] });
    return await WebUsbDapProbe.open(device, opts);
  }

  static async open(device, opts = {}){
    const p = new WebUsbDapProbe();
    p.device = device;
    await p._setup(opts);
    return p;
  }

  /**
   * @param {{skipTargetInit?:boolean, skipInfo?:boolean, skipClearHalt?:boolean, clockKhz?:number}} opts
   *   skipTargetInit=true 只认领 USB，不碰目标（自测/排障用）
   *   skipInfo=true 连 DAP_Info 都不问，让命令流与"验证过的裸客户端"完全一致
   *   clockKhz>0 指定 SWD 时钟；不指定则从高到低自动选（见 CLOCK_CANDIDATES）
   */
  async _setup({ skipTargetInit = false, skipInfo = false, skipClearHalt = false, clockKhz = 0 } = {}){
    this.skipTargetInit = skipTargetInit;
    this.skipClearHalt = skipClearHalt;
    await this._claim();
    const prod = this.device.productName || 'CMSIS-DAP';

    // 先按"验证过能跑通"的裸客户端顺序把目标初始化好（tools\cmsis_dap_raw.py），
    // Info 查询放**后面**做 —— 那份脚本一个 Info 都没发，序列越接近它越稳。
    if (!skipTargetInit){
      if (clockKhz > 0){
        await this._targetInit({ clock: clockKhz * 1000 });
        this.clockHz = clockKhz * 1000;
      } else {
        await this._negotiateClock();
      }
    }
    if (skipInfo) return;
    try {
      const ps = await this.info(0xff);
      if (ps.length >= 2){ const v = ps[0] | (ps[1] << 8); if (v > 0 && v <= 4096) this.pkt = Math.min(v, 512); }
      const pc = await this.info(0xfe);
      this.packetCount = pc[0] || 1;
      this.maxWords = Math.max(1, Math.min(120, Math.floor((this.pkt - 8) / 4)));
      this.name = `${prod} · ${this.pkt}B/包 · SWD ${Math.round(this.clockHz / 1000)}kHz`;
    } catch {}
  }

  /** USB 层：打开设备、找 bulk 端点、认领接口、清端点、同步清队列 */
  async _claim(){
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    let found = null;
    for (const iface of d.configuration.interfaces){
      for (const alt of iface.alternates){
        const bulk = (alt.endpoints || []).filter(e => e.type === 'bulk');
        const epIn = bulk.find(e => e.direction === 'in');
        const epOut = bulk.find(e => e.direction === 'out');
        if (epIn && epOut){ found = { iface, alt, epIn, epOut }; break; }
      }
      if (found) break;
    }
    if (!found) throw new Error('这个 USB 设备没有 CMSIS-DAP v2 的 bulk 端点（v1/HID 探针暂不支持，J-Link 也不支持）');
    this.iface = found.iface.interfaceNumber;
    this.epIn = found.epIn.endpointNumber;
    this.epOut = found.epOut.endpointNumber;
    this.pkt = Math.min(found.epIn.packetSize || 64, 512);
    try { await d.claimInterface(this.iface); } catch (e){ throw new Error(`占用 USB 接口失败：${e.message}（OpenOCD/pyOCD/J-Link 是不是还开着？）`); }

    /**
     * 🚨 认领接口后**必须清一次端点**。
     * 探针的 IN 端点里常常残留着上一次会话（OpenOCD/pyOCD/上一次网页会话）没被取走的响应包，
     * 而 `DAP_Transfer` 的陈旧失败响应（ACK=NO ACK、count=0）回显同样是 0x05，
     * 会被我的"按回显匹配"逻辑当成**当前命令的响应** → 现象是"目标明明 ACK 了，页面却报 NO ACK"。
     * libusb/pyusb 认领接口时会自己 clear_halt 冲掉这些数据，所以同一个探针用 Python 脚本一直是好的，
     * 只有 WebUSB 这条路上会踩到（本机实测：LA 上能看到目标回了 ACK=OK，页面却报 NO ACK）。
     */
    for (const [dir, ep] of [['in', this.epIn], ['out', this.epOut]]){
      if (this.skipClearHalt) break;
      try { await d.clearHalt(dir, ep); } catch (e){ console.warn(`clearHalt(${dir}) 失败：${e.message}`); }
    }
    await this.resync();
    this._ready = true;
    this.maxWords = Math.max(1, Math.min(120, Math.floor((this.pkt - 8) / 4)));
    this.name = `${d.productName || 'CMSIS-DAP'} · ${this.pkt}B/包`;
  }

  /**
   * SWD 时钟自动选档：按 CLOCK_CANDIDATES 的顺序试，第一个能读到合法 IDCODE 的就用。
   * 时钟过高会 NO ACK 或**读到错数据**（吞吐也不升反降），所以每次都靠
   * `_targetInit()` 里那笔「读 DP IDCODE + 校验」来判定通不通。
   */
  async _negotiateClock(){
    this.clockTried = [];
    let last = null;
    for (const khz of WebUsbDapProbe.CLOCK_CANDIDATES){
      this.clockTried.push(khz);
      try {
        await this._targetInit({ clock: khz * 1000 });
        this.clockHz = khz * 1000;
        if (this.clockTried.length > 1) console.info(`[dap] SWD 时钟降到 ${khz} kHz 才通（试过 ${this.clockTried.join('/')}）`);
        return this.clockHz;
      } catch (e){
        last = e;
        console.warn(`[dap] ${khz} kHz 不通：${e.message}`);
        // 每档失败后把 USB 会话重开一遍：拉过/折腾过的 SWD 引擎往往要重开会话才肯恢复
        try { await this.reopen({ negotiate: false }); } catch {}
      }
    }
    throw new Error(`所有 SWD 时钟档位都连不上目标（最后：${last?.message}）——查接线 / 复位 / 供电`);
  }

  // ---------------- 原始命令 ----------------
  /**
   * 发一条 CMSIS-DAP 命令并取回它的响应。
   *
   * 🚨 这里**不能**天真地"发一条读一条、读到什么就当成什么"：
   *    探针的 IN 端点里可能残留着**上一次会话**（OpenOCD / pyOCD / J-Link）没被取走的响应包，
   *    于是整条响应流错位一格。更阴的是 DAP_Info 的响应回显就是 0x00，
   *    所以错位后前两条 Info 会"假装成功"，一直到 DAP_Connect 才炸出
   *    「响应错位：发 0x2 收 0x0」（本机 MicroLink DAPLink 实测踩到）。
   *    → 按命令回显匹配，不匹配的陈旧包丢掉重读（一次只发一条命令，不存在流水线，
   *      所以丢掉的一定是陈旧的，不会是别人的）。
   */
  async _ctrl(cmd, payload){
    if (!this._ready) throw new Error('探针未连接');
    const n = 1 + (payload ? payload.length : 0);
    if (n > this.pkt) throw new Error(`CMSIS-DAP 命令太长（${n} > ${this.pkt} 字节/包）`);
    // 补齐到整包再发：本工作区验证过的裸客户端（tools\cmsis_dap_raw.py）就是这么做的，
    // 是这个探针唯一 100% 跑通的写法，照抄以消掉变量。
    const req = new Uint8Array(this.pkt);
    req[0] = cmd;
    if (payload) req.set(payload, 1);
    await withTimeout(this.device.transferOut(this.epOut, req), 3000, 'USB 写');
    for (let attempt = 0; attempt < 4; attempt++){
      const r = await withTimeout(this.device.transferIn(this.epIn, this.pkt), 3000, 'USB 读');
      if (!r.data || !r.data.byteLength) continue;                     // 空包：跳过
      const res = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      if (res[0] !== cmd){
        this.stale = (this.stale || 0) + 1;
        console.warn(`[dap] 丢弃陈旧响应包（回显 0x${res[0].toString(16)} ≠ 命令 0x${cmd.toString(16)}，第 ${this.stale} 个）`);
        continue;
      }
      return res.subarray(1);
    }
    throw new Error(`CMSIS-DAP 连续 4 次都没读到命令 0x${cmd.toString(16)} 的响应（探针掉线？）`);
  }

  async info(id){
    const r = await this._ctrl(CMD.Info, Uint8Array.of(id));
    return r.subarray(1, 1 + (r[0] || 0));                 // r[0] = 长度
  }

  /**
   * 把 IN 端点里**上一场会话残留的响应**清干净。
   *
   * 为什么需要：探针的响应是"命令回显 + 载荷"，而**回显不唯一** ——
   * 残留的 `DAP_Transfer` 响应回显同样是 0x05，于是"按回显匹配"根本分不出来，
   * 会把上一次会话（OpenOCD/上一次网页会话）的失败响应当成自己这条的响应。
   * 现象诡异：初始化看着正常，一写下行命令就出怪事（地址/指针全不对）。
   *
   * 做法：连发 N 条 `DAP_Disconnect`（回显 0x03，很少见），再把 N 条响应全部读掉。
   * 每一读都有对应的一条响应，所以**不会**出现"传输被弃置"（WebUSB 没有取消接口，
   * 弃置的 transferIn 会偷走下一条响应 —— 用超时去 flush 就是踩这个坑）。
   */
  async resync(n = 8){
    const pkt = new Uint8Array(this.pkt);
    pkt[0] = CMD.Disconnect;
    for (let i = 0; i < n; i++){
      try { await this.device.transferOut(this.epOut, pkt); } catch { return; }
    }
    let saw = 0;
    for (let i = 0; i < n; i++){
      let r;
      try { r = await withTimeout(this.device.transferIn(this.epIn, this.pkt), 1500, 'USB 同步读'); }
      catch { break; }
      if (!r.data || !r.data.byteLength) break;
      const b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      if (b[0] === CMD.Disconnect) saw++;
    }
    if (saw) console.info(`[dap] 同步清队列：吃掉 ${saw} 条陈旧响应`);
    return saw;
  }

  /**
   * 清 sticky 错误。
   * 🚨 读到没映射的地址会拿到 FAULT，而 **FAULT 会在 DP 里置 STICKYERR 位**，
   *    不清掉的话后面每一次 AP 访问都会继续 FAULT —— 表现成"探针突然瞎了"。
   *    写 DP ABORT 的 STKCMPERR|STKERR|WDERR|ORUNERR(=0x1E) 就是干这个的。
   */
  async abort(){
    try { await this._ctrl(CMD.WriteABORT, Uint8Array.of(0x1e, 0x00, 0x00, 0x00)); } catch {}
  }

  async setClock(hz){
    await this._ctrl(CMD.SWJ_Clock, u32leBytes(hz));
  }

  /**
   * DAP_SWJ_Sequence：按位输出一段序列（用来做 SWD 线复位）。
   * 🚨 请求格式是 `[命令, 位计数(1 字节), 数据...]`，**位计数只有 1 个字节**，
   *    且 0 表示 256（ARM 参考实现：count = *request++; if (count == 0) count = 256;）。
   *    早期按 2 字节发 → 固件把数据整体错位一格，线复位变成垃圾序列，
   *    后果是后面所有传输一路 NO ACK（本机实测踩到，排了很久）。
   */
  async swjSequence(bitCount, bytes){
    if (!(bitCount > 0 && bitCount <= 256)) throw new Error(`SWJ 序列位计数非法：${bitCount}`);
    const p = new Uint8Array(1 + bytes.length);
    p[0] = bitCount === 256 ? 0 : bitCount;
    p.set(bytes, 1);
    await this._ctrl(CMD.SWJ_Sequence, p);
  }

  /**
   * SWD 激活序列（**一次 88 位**）：JTAG→SWD 切换(0x9E 0xE7) + 线复位(64 个 1) + 空闲(8 个 0)。
   *
   * 🚨 这一步不能省、也不能拆开发：少了它 SWJ-DP 还停在 JTAG 模式，
   *    之后所有 DAP_Transfer 一律返回 **NO ACK(0x07)**（看着像"固件不应答"，其实是主机不合规）。
   *    本机 MicroLink DAPLink + STM32F103 实测：拆成 16/64/8 三次发、或把末尾空闲写成 0xFF，
   *    都会让这个探针的 SWJ 引擎进入"传输全 NO ACK"的状态 —— 必须按下面这一种写法。
   *    出处：SEGGER/pyOCD 的标准做法，也是本工作区 tools\cmsis_dap_raw.py 验证过的那份。
   */
  async swdActivation(){
    const data = new Uint8Array(11);
    data[0] = 0x9e; data[1] = 0xe7;              // JTAG-to-SWD 切换
    data.fill(0xff, 2, 10);                      // 8 字节 0xFF = 64 位线复位
    data[10] = 0x00;                             // 8 位空闲（SWDIO 低）
    await this.swjSequence(88, data);
  }

  /**
   * 单条/多条 DAP_Transfer。ops: {ap,rnw,addr,data}[] → 读回的值数组
   * 请求布局（CMSIS-DAP 规范）：[CMD, DAP索引, 传输条数, (请求字节 + 4字节数据) × N]
   * 🚨 这里踩过：组包时漏掉「DAP索引 + 传输条数」这两个字节，固件就会把请求字节
   *    当成条数读 → 响应 count=0 / ACK=0，看起来像"目标没应答"。
   */
  async _transfer(ops){
    const count = ops.length;
    const payload = new Uint8Array(2 + count * 5);
    payload[0] = 0;                                  // DAP 索引
    payload[1] = count;                              // 传输条数
    let o = 2;
    for (const op of ops){
      payload[o] = reqByte(op.ap, op.rnw, op.addr);
      if (!op.rnw) payload.set(u32leBytes(op.data >>> 0), o + 1);
      o += 5;
    }
    if (1 + payload.length > this.pkt) throw new Error(`DAP_Transfer 超过一个包（${1 + payload.length} > ${this.pkt}）`);
    const res = await this._ctrl(CMD.Transfer, payload);
    const n = res[0];
    const rv = res[1];
    const ack = rv & 0x07;
    const vals = [];
    for (let i = 0; i < n && 2 + i * 4 + 4 <= res.length; i++) vals.push(u32le(res, 2 + i * 4));
    if (ack !== 1){
      if (ack === 4) await this.abort();                    // FAULT → 清 sticky，否则后面全废
      const err = new Error(`SWD ${ACK[ack] || ('ACK=' + ack)}（传输 ${n}/${count} 条，地址 0x${(ops[0]?.addr || 0).toString(16)}）`);
      err.ack = ack;
      throw err;
    }
    return vals;
  }

  async _transferBlock(rnw, count, addr, words){
    const req = new Uint8Array(4 + (rnw ? 0 : count * 4));
    req[0] = 0; req[1] = count & 0xff; req[2] = (count >> 8) & 0xff;
    req[3] = reqByte(true, rnw, addr);
    if (!rnw) for (let i = 0; i < count; i++) req.set(u32leBytes(words[i] >>> 0), 4 + i * 4);
    const res = await this._ctrl(CMD.TransferBlock, req);
    const got = res[0] | (res[1] << 8);
    const ack = res[2] & 0x07;
    if (ack !== 1){
      if (ack === 4) await this.abort();                    // 同上：FAULT 必须清 sticky
      const err = new Error(`SWD 块传输 ${ACK[ack] || ('ACK=' + ack)}（${rnw ? '读' : '写'} ${count} 字 @0x${addr.toString(16)}）`);
      err.ack = ack;
      throw err;
    }
    if (rnw){
      const out = new Uint32Array(count);
      for (let i = 0; i < count && 3 + i * 4 + 4 <= res.length; i++) out[i] = u32le(res, 3 + i * 4);
      return { count: got, words: out };
    }
    return { count: got, words: null };
  }

  // ---------------- 目标初始化 ----------------
  /**
   * 让 SWD 链路可用。顺序**逐条对齐**验证过能跑通的裸客户端（tools\cmsis_dap_raw.py）：
   *   Connect(SWD) → SWJ_Clock → **SWD_Configure** → **SWJ_Sequence(88 位激活)** → TransferConfigure
   * 少一步都不行：早期版本漏了 SWD_Configure、把激活序列拆成三次发，结果所有传输 NO ACK。
   */
  async _targetInit({ clock = null } = {}){
    const hz = Number(clock || this.clockHz || 1_000_000);
    const port = await this._ctrl(CMD.Connect, Uint8Array.of(1));      // 1 = SWD
    if (port[0] !== 1) throw new Error(`DAP_Connect 失败（返回 ${port[0]}，期望 1=SWD）`);
    await this.setClock(hz);
    await this._ctrl(CMD.SWD_Configure, Uint8Array.of(0));             // turnaround=1 / data_phase=0
    await this.swdActivation();                                       // 88 位激活序列（关键！）
    await this._ctrl(CMD.TransferConfigure, Uint8Array.of(0, 0xe8, 0x03, 0, 0));  // idle=0, retry=1000

    /**
     * 🚨 **线复位之后的第一个 SWD 包必须是「读 DP IDCODE」**（ARM SWD 协议的激活步骤）。
     *    少了这一笔，后面任何访问（哪怕是写 DP SELECT）都返回 NO ACK(0x07) ——
     *    现象极具误导性："包头完全正确、探针也回 ACK 字段，但就是 NO ACK"。
     *    本机是靠在页面上做参数扫描（tools\selftest\debug-sweep.mjs）才定位到的：
     *      激活序列 + 第一笔读 IDCODE → ack=1；
     *      激活序列 + 第一笔写 SELECT → ack=7。
     */
    const id = await this._transfer([{ ap: false, rnw: true, addr: DP_IDCODE }]);
    this.idcode = (id[0] >>> 0);
    if (!this.idcode || this.idcode === 0xffffffff){
      throw new Error(`读 DP IDCODE 失败（0x${this.idcode.toString(16)}）→ SWD 没连上：接线/复位/时钟都要看一眼`);
    }

    // DP SELECT = 0（选 AP0、bank0）
    await this._transfer([{ ap: false, rnw: false, addr: DP_SELECT, data: 0 }]);
    // 🚨 AP 访问前必须给 DP 上电，否则后面全是 FAULT（pyOCD 的 DebugPortSetup 就是干这个）
    await this._transfer([{ ap: false, rnw: false, addr: DP_CTRL_STAT, data: 0x50000000 }]);
    await sleep(20);
    const st = await this._readDP(DP_CTRL_STAT);
    if (!(st & (1 << 31))) console.warn('DP 电源应答位没起来（0x' + st.toString(16) + '），继续试');
    // CSW：32 位 + 单次自增（保留其它位）
    const csw = await this._readAP(AP_CSW);
    const want = (csw & ~0x3f) | 0x02 | 0x10;
    if (want !== csw) await this._writeAP(AP_CSW, want);
    this.csw = want;
  }

  /** DP 读是「挂起读」：读一次拿的是上一次的结果，所以读两遍 */
  async _readDP(addr){
    await this._transfer([{ ap: false, rnw: true, addr }]);
    const v = await this._transfer([{ ap: false, rnw: true, addr: DP_RDBUFF }]);
    return v[0] >>> 0;
  }
  async _readAP(addr){
    const v = await this._transfer([{ ap: true, rnw: true, addr }]);
    return v[0] >>> 0;
  }
  async _writeAP(addr, val){
    await this._transfer([{ ap: true, rnw: false, addr, data: val }]);
  }
  async _setTAR(addr){
    await this._transfer([{ ap: true, rnw: false, addr: AP_TAR, data: addr >>> 0 }]);
  }

  // ---------------- 内存访问（RTT 只用到这两个） ----------------
  async readMem(addr, len){
    if (len <= 0) return new Uint8Array(0);
    if (len > (1 << 20)) throw new Error(`一次要读 ${len} 字节（>1MB），地址参数大概是错了`);
    const start = addr & ~3;
    const end = (addr + len + 3) & ~3;
    const bytes = new Uint8Array(end - start);
    const dv = new DataView(bytes.buffer);
    let a = start;
    await this._setTAR(start);
    while (a < end){
      const words = Math.min(this.maxWords, (end - a) >> 2);
      const { words: got } = await this._transferBlock(true, words, AP_DRW, null);
      for (let i = 0; i < words; i++) dv.setUint32(a - start + i * 4, got[i] >>> 0, true);
      a += words * 4;
      if (words === 0) break;
    }
    return bytes.subarray(addr - start, addr - start + len);
  }

  async writeMem(addr, bytes){
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!data.length) return;
    if ((addr & 3) === 0 && (data.length & 3) === 0){
      const words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
      await this._setTAR(addr);
      let i = 0;
      while (i < words.length){
        const n = Math.min(this.maxWords, words.length - i);
        await this._transferBlock(false, n, AP_DRW, words.subarray(i, i + n));
        i += n;
      }
      return;
    }
    // 非对齐 → 读-改-写（RTT 下行缓冲的写指针可能不是 4 的倍数）
    const start = addr & ~3;
    const end = (addr + data.length + 3) & ~3;
    const cur = await this.readMem(start, end - start);
    cur.set(data, addr - start);
    const words = new Uint32Array(cur.buffer, cur.byteOffset, cur.length >> 2);
    await this._setTAR(start);
    let i = 0;
    while (i < words.length){
      const n = Math.min(this.maxWords, words.length - i);
      await this._transferBlock(false, n, AP_DRW, words.subarray(i, i + n));
      i += n;
    }
  }

  // ---------------- 目标控制 ----------------
  /**
   * 运行/停止目标：写 Cortex-M 的 DHCSR(0xE000EDF0)，高 16 位键值 0xA05F 必填。
   *   C_DEBUGEN(bit0)=1 且 C_HALT(bit1)=0 → 运行；C_HALT=1 → 停止。
   * 🚨 为什么需要它：DAPLink 的 DAP_ResetTarget 之后目标常常**停在 halt 状态**
   *    （"复位并停住"是调试器的常规语义），于是 RTT 连得上、控制块也读得到，
   *    但固件不跑 ⇒ 一个字节都不来。本页的复位按钮 = 复位并运行，靠的就是这个。
   */
  async _dhcsr(value){
    await this._setTAR(0xE000EDF0);
    await this._transferBlock(false, 1, AP_DRW, Uint32Array.of(value >>> 0));
  }
  async run(){ await this._dhcsr(0xA05F0001); }
  async halt(){ await this._dhcsr(0xA05F0003); }
  /** @returns {Promise<boolean>} 目标当前是否处于 halt（DHCSR.S_HALT = bit17） */
  async isHalted(){
    try {
      const b = await this.readMem(0xE000EDF0, 4);
      return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 17 & 1) === 1;
    } catch { return false; }
  }

  /**
   * 复位目标。
   *
   * 🚨 顺序很要紧（本机 MicroLink DAPLink + STM32F103 实测）：
   *    **首选拉 nRESET 脉冲**（等价按一下复位键）。它不碰调试寄存器，
   *    放开后内核自己从 0 启动 —— 行为最干净。
   *    而 DAPLink 的 DAP_ResetTarget 会"复位并停住"，实测还能把目标留在
   *    半启动状态（.bss 都没清完，RTT 控制块地址上全是上一次的日志文本），
   *    之后写 DHCSR 让它跑也救不回来。所以只把它当兜底。
   *    另外 wait 参数单位是**微秒**：早期写成 1000000 = 每次调用卡 1 秒。
   */
  async reset(){
    const pins = async (value, waitUs) => {
      const p = new Uint8Array(6);
      p[0] = value; p[1] = SWJ_nRESET;
      p[2] = waitUs & 0xff; p[3] = (waitUs >> 8) & 0xff; p[4] = (waitUs >> 16) & 0xff; p[5] = (waitUs >> 24) & 0xff;
      return await this._ctrl(CMD.SWJ_Pins, p);
    };
    try {
      await pins(0x00, 20000);            // nRESET 拉低 20ms
      await pins(SWJ_nRESET, 50000);      // 放开 50ms
      await sleep(150);
      // 复位后重新建立 SWD：先老实来一遍，不行再来一遍（拉过 nRESET 之后第一次常常不认）
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++){
        try { await this._targetInit(); lastErr = null; break; }
        catch (e){ lastErr = e; await sleep(120); }
      }
      if (lastErr) throw lastErr;
      const halted = await this.isHalted();
      if (halted) await this.run();
      return 'nRESET 脉冲' + (halted ? '（目标被停住，已让它运行）' : '');
    } catch (e){
      /**
       * 🚨 nRESET 脉冲之后 SWD 可能整条哑掉（实测：拉过 nRESET 之后再怎么发激活序列都是 NO ACK）。
       *    这时候唯一的干净恢复是**把 USB 会话整个重开一遍**（释放接口再认领 + 重新初始化），
       *    也就是把探针从"上一次会话的残留状态"里拉出来。用户手动拔插也能好，但那样太傻。
       */
      console.warn('复位后 SWD 不可用，重开 USB 会话：' + e.message);
      const dev = this.device;
      try { await this.reopen(); } catch (e2){
        throw new Error(`复位后 SWD 无法恢复：${e.message} / 重开也失败：${e2.message}`);
      }
      await this._targetInit();
      await this.run();
      return 'nRESET 脉冲 + 重开探针会话（原 SWD 已哑：' + e.message + '）';
    }
  }

  /** 释放接口再认领、按**当前时钟**重跑一遍初始化 —— 比让用户拔插 USB 体面 */
  async reopen(){
    try { await this.device.releaseInterface(this.iface); } catch {}
    this._ready = false;
    await sleep(120);
    await this._claim();
    await this._targetInit({ clock: this.clockHz });
    return true;
  }

  async disconnect(){
    try { await this._ctrl(CMD.Disconnect); } catch {}
    try { await this.device.releaseInterface(this.iface); } catch {}
    try { await this.device.close(); } catch {}
    this._ready = false;
  }

  /**
   * 自愈：SWD 访问报 FAULT / NO ACK 时重新初始化调试口。
   * 幂等 —— 重连 SWD、重新给 DP 上电、重设 CSW；目标被停住就让它跑。
   * ⚠️ 中途**不要**用 DAP_Disconnect/Connect 去"重连"（实测会把链路搞成一路 NO ACK），
   *    要恢复就重新走 _targetInit()，实在不行只能重新打开 USB 设备。
   */
  async recover(){
    await this._targetInit();
    try { if (await this.isHalted()) await this.run(); } catch {}
    return true;
  }
}
