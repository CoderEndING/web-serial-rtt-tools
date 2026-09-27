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

/**
 * 被「挂起传输」搞脏的设备。
 *
 * 🚨 WebUSB **没有取消接口**：`withTimeout` 超时只是"我们不等了"，底层那次 bulk 传输
 *    还挂在 USB 栈里 —— 它会偷走下一条响应，攒多了还会把整个 USB 服务搞到
 *    `navigator.usb.getDevices()` / `device.open()` 都不返回（实测：连不上几次之后，
 *    连烧录器都卡在第一步 getDevices() 上，90 秒不动）。
 *    唯一的解药是 **USB 端口复位**（`device.reset()`，会清掉挂起传输），其次是重开设备。
 *    所以这里把"出现过超时"的设备记下来，下次认领前先复位。
 */
const dirty = new WeakSet();

/** 给任意 promise 套超时（超时只是放弃等待；USB 层要靠 dirty+reset 收拾） */
export async function withTimeout(p, ms, what){
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} 超时（${ms}ms）：探针没响应`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

/** USB 端口复位（清挂起传输）；成功返回 true */
async function resetDevice(device){
  if (!device || !device.opened) return false;
  try {
    await withTimeout(device.reset(), 3000, 'USB 端口复位');
    dirty.delete(device);
    console.info('[dap] 已做 USB 端口复位（清掉上一次会话的挂起传输）');
    return true;
  } catch (e){
    console.warn(`[dap] USB 端口复位失败：${e.message}（可能要拔插一次探针）`);
    return false;
  }
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
    this._posted = false;              // 是否有未冲干净的 posted（后发）写
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
    // 🚨 上一次会话如果有过超时，USB 栈里可能还挂着传输 —— 会偷响应、甚至让
    //    getDevices()/open() 整条卡死。先做端口复位清掉（在 open 之前做最安全）。
    if (dirty.has(d)){
      console.warn('[dap] 这个探针上次有超时（挂起传输），先复位 USB 端口再认领');
      try { if (!d.opened) await withTimeout(d.open(), 5000, 'USB 打开'); } catch {}
      await resetDevice(d);
    }
    if (!d.opened) await withTimeout(d.open(), 5000, 'USB 打开（卡住通常是探针被别的程序占着）');
    if (d.configuration === null) await withTimeout(d.selectConfiguration(1), 5000, 'USB 选择配置');
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
    try {
      await withTimeout(d.claimInterface(this.iface), 5000, 'USB 认领接口');
    } catch (e){
      throw new Error(`占用 USB 接口失败：${e.message}（OpenOCD/pyOCD/J-Link 是不是还开着？）`);
    }

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
      try { await withTimeout(d.clearHalt(dir, ep), 2000, `clearHalt(${dir})`); }
      catch (e){ console.warn(`clearHalt(${dir}) 失败：${e.message}`); }
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
    try {
      await withTimeout(this.device.transferOut(this.epOut, req), 3000, 'USB 写');
    } catch (e){
      dirty.add(this.device);                 // 写超时：底层传输可能还挂着 → 标脏
      throw e;
    }
    for (let attempt = 0; attempt < 4; attempt++){
      let r;
      try {
        r = await withTimeout(this.device.transferIn(this.epIn, this.pkt), 3000, 'USB 读');
      } catch (e){
        dirty.add(this.device);               // 读超时：挂起传输会偷走后续响应 → 标脏
        throw e;
      }
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
      try { await withTimeout(this.device.transferOut(this.epOut, pkt), 1500, 'USB 同步写'); }
      catch { dirty.add(this.device); return 0; }
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
  async _transfer(ops, apIndex = 0){
    const count = ops.length;
    const payload = new Uint8Array(2 + count * 5);
    payload[0] = apIndex;                            // DAP 索引 = APSEL（0=AHB-AP，1=APB-AP 调试口）
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
      // 出过错之后 TAR 已自增到不可知的位置、posted 写也不可信 → 标记作废（下次访问会重写 TAR）
      this._posted = false;
      if (ack === 4) await this.abort();                    // FAULT → 清 sticky，否则后面全废
      const err = new Error(`SWD ${ACK[ack] || ('ACK=' + ack)}（传输 ${n}/${count} 条，地址 0x${(ops[0]?.addr || 0).toString(16)}）`);
      err.ack = ack;
      throw err;
    }
    return vals;
  }

  async _transferBlock(rnw, count, addr, words, apIndex = 0){
    const req = new Uint8Array(4 + (rnw ? 0 : count * 4));
    req[0] = apIndex; req[1] = count & 0xff; req[2] = (count >> 8) & 0xff;
    req[3] = reqByte(true, rnw, addr);
    if (!rnw) for (let i = 0; i < count; i++) req.set(u32leBytes(words[i] >>> 0), 4 + i * 4);
    const res = await this._ctrl(CMD.TransferBlock, req);
    const got = res[0] | (res[1] << 8);
    const ack = res[2] & 0x07;
    if (ack !== 1){
      this._posted = false;
      if (ack === 4) await this.abort();                    // 同上：FAULT 必须清 sticky
      const err = new Error(`SWD 块传输 ${ACK[ack] || ('ACK=' + ack)}（${rnw ? '读' : '写'} ${count} 字 @0x${addr.toString(16)}）`);
      err.ack = ack;
      throw err;
    }
    if (rnw){
      /**
       * 🚨 只返回**响应里真正带着的那些字**。
       *    这颗探针会把块读响应截短（120 字的请求常常只回一部分）；
       *    早期写法先 `new Uint32Array(count)` 再把没填满的槽留成 0 —— 于是"读回来一堆 0"，
       *    上层拿去算地址/指针就会算出垃圾（写错地址、踩坏控制块、RTT 突然连不上）。
       *    这里按响应实际长度算能给出几个字，并把 count 也按实际值报回去，
       *    让调用方（_readMemOnce）能正确地"接着读完剩下的"。
       */
      const avail = Math.max(0, Math.floor((res.length - 3) / 4));
      const n2 = Math.min(count, avail);
      const out = new Uint32Array(n2);
      for (let i = 0; i < n2; i++) out[i] = u32le(res, 3 + i * 4);
      return { count: Math.min(got, n2), words: out };
    }
    this._posted = true;                                   // DRW 写是 posted：改 TAR 前必须冲
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
    this._posted = false;                             // 新会话：未完成的 posted 写作废
    const port = await this._ctrl(CMD.Connect, Uint8Array.of(1));      // 1 = SWD
    if (port[0] !== 1) throw new Error(`DAP_Connect 失败（返回 ${port[0]}，期望 1=SWD）`);
    await this.setClock(hz);
    await this._ctrl(CMD.SWD_Configure, Uint8Array.of(0));             // turnaround=1 / data_phase=0
    await this.swdActivation();                                       // 88 位激活序列（关键！）
    // 🚨 激活后第一个包必须是「读 IDCODE」（写会 NO ACK，见 docs/backends.md 坑②），
    //    所以清 sticky 的 ABORT 要排在 IDCODE 读取之后、第一条 AP 访问之前
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
    // 注：不要在这里插 ABORT 清 sticky —— 本探针的 DP 状态机对激活后中途 ABORT 敏感
    // （实测 SELECT 写会 FAULT）。sticky 清理靠失败路径的 reopen()/abort()。

    // DP SELECT = 0（选 AP0、bank0）
    await this._transfer([{ ap: false, rnw: false, addr: DP_SELECT, data: 0 }]);
    // AP 访问前必须给 DP 上电（pyOCD 的 DebugPortSetup 就是干这个）。
    // 先走正常路径（纯上电 + 清 sticky 重试）；只有它连着失败，才动用「掉电-上电」最后手段。
    try {
      await this._powerUpDP();
    } catch (e){
      console.warn(`[dap] DP 上电失败（${e.message}），改用掉电-上电最后手段`);
      await this.powerCycle();
    }
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
  async _readAP(addr, apIndex = 0){
    const v = await this._transfer([{ ap: true, rnw: true, addr }], apIndex);
    return v[0] >>> 0;
  }
  async _writeAP(addr, val, apIndex = 0){
    await this._transfer([{ ap: true, rnw: false, addr, data: val }], apIndex);
    this._posted = true;                              // AP 写按 posted 处理，改 TAR 前冲一次最稳
  }
  /** 写 DP 寄存器（调试口的选择/控制都在这里，如 DP_SELECT 的 APSEL 字段） */
  async _writeDP(addr, val){
    await this._transfer([{ ap: false, rnw: false, addr, data: val >>> 0 }]);
  }

  /**
   * 给调试口上电：写 DP CTRL/STAT 的 CSYSPWRUPREQ|CDBGPWRUPREQ。
   *
   * 🚨 **千万别先写 0「掉电」再上电**（6bba430 加过这一步，直接把 RTT 连接搞挂）：
   *    本机 MicroLink(CherryUSB) + STM32F103 实测，掉电写之后那个上电写会稳定返回
   *    **FAULT(4)**（浏览器线级抓包与裸客户端两边都复现），而 _transfer 见 FAULT 就抛
   *    → 现象正是「RTT 总是连不上，偶尔又能连上」。更糟的是炸过一次之后 DP 停在
   *    「掉电已请求 + sticky」，下一次连接照样炸 —— 自锁（3209a87 之前没有这步，一直很稳）。
   *    网页里 sleep(50) 还会被后台节流成 ~200ms，掉电更彻底、命中率更高。
   * 这里保留一次「清 sticky 再重试」的兜底：万一真撞上 FAULT 也能自己爬起来。
   */
  async _powerUpDP(attempts = 2){
    let lastErr = null;
    for (let i = 1; i <= attempts; i++){
      try {
        await this._writeDP(DP_CTRL_STAT, 0x50000000);
        return true;
      } catch (e){
        lastErr = e;
        if (e.ack !== 4) throw e;                    // 不是 FAULT（NO ACK / WAIT）→ 重试也没意义
        await this.abort();                          // FAULT → 清 sticky
        await sleep(20);
      }
    }
    throw lastErr;
  }

  /**
   * 掉电 → 上电：**只在 recover() 里当最后手段**，用来清「上一个会话（被 kill 的 OpenOCD 等）
   * 把 DP 楔死」这种顽固状态。⚠️ 它在部分目标上会让上电写 FAULT（见 _powerUpDP），
   * 所以正常连接路径一律走 _powerUpDP()。
   */
  async powerCycle(){
    try { await this._writeDP(DP_CTRL_STAT, 0x00000000); } catch {}
    await sleep(30);
    return await this._powerUpDP(3);
  }

  /**
   * 把 pending 的 **posted 写**冲干净。
   *
   * 做法：读一次 **DP 的 RDBUFF**。ARM 规定读它会让此前所有 posted 的 AP 事务完成，
   * 而且它是 DP 读，**不会**把数据塞进 AP 的挂起读流水线。
   *
   * 🚨 千万别用「读 AP DRW」来冲（前一版就是这么写的，栽了）：AP 的读是**挂起读**
   *    （读回的是上一次读事务的结果），读一次 DRW 会把刚写进去的数据挂到流水线上，
   *    紧接着的下一次块读就会把**头几个字读成这些旧数据**。
   *    实测现场：下行写完 "help\r" 后再读 RTT 控制块，读回来的前 8 字节正是 "help\r\0\0\0"
   *    → 控制块被判"缓冲指针无效(0xd)" → 连接直接失败（看着像"RTT 又连不上了"）。
   */
  async _flushPosted(){
    if (!this._posted) return;
    this._posted = false;
    await this._transfer([{ ap: false, rnw: true, addr: DP_RDBUFF }]);
  }

  /**
   * 设置 AP 的 TAR（目标地址）—— **每次块访问前都必须写**，不做「地址没变就跳过」的缓存。
   *
   * 🚨 为什么不能省（本机 MicroLink(CherryUSB) + STM32F103 实测，裸客户端与网页两边都复现）：
   *    这条链路的 CSW 开着地址自增（AddrInc=1），**每次 DRW 访问都会让 TAR 往前走**，
   *    而且访问完不会自己回来。所以"地址没变就不用重写 TAR"是错的 ——
   *    同址连读第 2 次起读回来的就是**后面几个字**的内容，表现为 RTT 日志"错位/跳相位"：
   *    这正是 60ccc42 / 93838d7 / 6bba430 一路在追的「错位读」。
   *    对照实测（tmp/dap_tar_repeat.py）：
   *      · 每次重写 TAR → 同址连读 5 次全部是 "SEGGER RTT"（正确）
   *      · 不重写 TAR   → 第 1 次对，第 2 次起读到 CB+16 / CB+32 的内容（错）
   *    注：跨块的多字块读靠的就是这个自增，所以**同一个 TAR 内**连续 TransferBlock 是对的；
   *    要换地址时重写一次即可。
   *
   * 另外：改 TAR 之前先把上一笔 posted（后发）的 DRW 写冲干净，否则那笔写会落到新地址上
   * （烧录器「固件能写、某个寄存器写不进去」就是这么来的）。
   */
  async _setTAR(addr, apIndex = 0){
    await this._flushPosted();
    await this._transfer([{ ap: true, rnw: false, addr: AP_TAR, data: addr >>> 0 }], apIndex);
    /**
     * ⚠️ 这里**不要**再插任何"屏障读"，两种都试过、都更糟：
     *   · 读 AP CSW / AP DRW（6bba430 与后来我都试过）：AP 读是**挂起读**，
     *     会把旧值顶进读流水线 → DHCSR 轮询报「S_REGRDY 没置位」、RTT 直接连不上；
     *   · 读 DP RDBUFF：不污染 AP 流水线，但实测会让 `_targetInit` 里的
     *     「写 DP SELECT」直接 FAULT（SWD FAULT，地址 0x8）。
     * 现状策略（实测可用）：TAR 每次都重写 + posted 写用 DP RDBUFF 冲（只在写之后、改 TAR 之前），
     * 写操作靠 writeMem 的回读确认兜底。
     */
  }

  // ---------------- 内存访问（RTT 只用到这两个） ----------------
  /**
   * 读目标内存。
   *
   * 🚨 **地址必须先 `>>> 0` 归一化**：JS 的位运算（`& ~3`）是 **32 位有符号**的，
   *    地址一旦 ≥ 0x80000000（PPB 区就是，例如 DHCSR=0xE000EDF0）就会变成负数，
   *    而 `addr` 本身还是正数 → `addr - start` 差出 2^32 → `subarray` 越界 →
   *    **返回空数组**（不是报错！）。后果极隐蔽：
   *      · `isHalted()` 永远读不到 S_HALT → 看门狗以为目标在跑，不去唤醒被 halt 的目标；
   *      · flashloader 的 `regRead/regWrite` 永远读不到 S_REGRDY → 报
   *        「调试寄存器同步超时（S_REGRDY 没置位）」——就是烧录器"某个寄存器写不进去"的真身
   *        （其实写进去了，是**读回**全空）。
   *    → 本函数与 writeMem 一律先把 addr 归一化成无符号，start/end 也 `>>> 0`。
   */
  /**
   * 把一段内存访问**串行化**。
   *
   * 🚨 为什么必须有：页面里同时有两条路径在碰同一个探针 —— RTT 轮询循环（读上行缓冲 + 推进 RdOff）
   *    和用户的下行发送（读下行表项 + 写数据 + 写 WrOff）。两者都在 await 处让出，**交错执行**；
   *    而 TAR、AP 挂起读流水线、posted 写都是**探针/AP 上的共享状态**：
   *      A 写了 TAR=X → B 写 TAR=Y → A 的读落到 Y 上 → A 拿到垃圾（读出的 WrOff/size 是假的）
   *      → 命令写丢（实测：页面"发送成功"、固件一个字节都没收到）。
   *    早期之所以"偶尔好偶尔坏"，就是因为交错窗口时大时小。
   *    这里用一条 promise 链互斥，保证一次内存访问序列跑完再让下一个进来（可重入，内部调用不卡死）。
   */
  async _withLock(fn){
    if (this._locked){ return await fn(); }          // 可重入：writeMem 内部会调 readMem
    let release;
    const prev = this._lockChain || Promise.resolve();
    this._lockChain = new Promise(r => { release = r; });
    await prev;
    this._locked = true;
    try { return await fn(); }
    finally { this._locked = false; release(); }
  }

  async readMem(addr, len, apIndex = 0){
    return await this._withLock(() => this._readMemLocked(addr, len, apIndex));
  }

  /**
   * 读目标内存。
   *
   * 抗「挂起读」的策略**按数据量分级**（2026-09-27 调过两轮：
   * 早先不分大小一律读两遍，大流量读取成本直接翻倍 —— 8MHz 下 330 KB/s 掉到 154 KB/s）：
   *   · 大块（RTT 缓冲、flash 校验……）：读一遍，但写完 TAR 后**先读两个字丢掉**（prime），
   *     把流水线里上一笔事务的残渣顶出去。只多一次往返。
   *   · 小块（≤ 64 字节）：也读一遍；**结构校验不通过时由上层重读**
   *     （Rtt._entry 会校验 size/pbuf/wr/rd 是否合理，不合理就重读一次——
   *     实测残留数据几乎都过不了这层校验，所以"按需重读"够用，省掉无脑双读）。
   * 另外地址必须先 `>>> 0` 归一化：JS 位运算（`& ~3`）是 32 位有符号的，
   * 地址 ≥ 0x80000000（PPB 区，如 DHCSR=0xE000EDF0）会变负数 → subarray 越界 → 返回空数组。
   */
  async _readMemLocked(addr, len, apIndex = 0){
    return await this._readMemOnce(addr, len, apIndex, len > 64);
  }

  async _readMemOnce(addr, len, apIndex = 0, prime = false){
    addr = addr >>> 0;
    if (len <= 0) return new Uint8Array(0);
    if (len > (1 << 20)) throw new Error(`一次要读 ${len} 字节（>1MB），地址参数大概是错了`);
    const start = (addr & ~3) >>> 0;
    const end = ((addr + len + 3) & ~3) >>> 0;
    const bytes = new Uint8Array(end - start);
    const dv = new DataView(bytes.buffer);
    let a = start;
    await this._setTAR(start, apIndex);
    if (prime){
      // 顶掉流水线里的残渣（结果丢弃）。挂起读的第一笔数据来自上一次读事务，
      // 大块读时这一笔就会变成"开头几个字是别的地址的内容"。
      try { await this._transferBlock(true, 2, AP_DRW, null, apIndex); } catch {}
    }
    while (a < end){
      const words = Math.min(this.maxWords, (end - a) >> 2, this._wordsToBoundary(a));
      if (this._needsTarReset(a, start)) await this._setTAR(a, apIndex);      // 4KB 边界：自增会绕回
      const { count: got, words: vals } = await this._transferBlock(true, words, AP_DRW, null, apIndex);
      /**
       * 🚨 探针**会把块读响应截短**（本机 120 字的请求常常只回一部分），
       *    早先的写法把没填到的字**静默留成 0** —— 于是"校验读到 0x0，其实 flash 是对的"。
       *    这里按响应里真实返回的条数推进，接着把剩下的读完（TAR 已自增）。
       */
      const n = Math.min(got, words, vals.length);
      for (let i = 0; i < n; i++) dv.setUint32(a - start + i * 4, vals[i] >>> 0, true);
      if (n === 0) break;
      a += n * 4;
    }
    return bytes.subarray(addr - start, addr - start + len);
  }

  /**
   * 一次块访问最多能走几个字（不许跨 **1KB 边界**，且到 4KB 边界必须重设 TAR）。
   *
   * 🚨 ADIv5 的 TAR 自增是**有界**的：连续多块的 DAP_TransferBlock 不会一路加下去。
   *    本机实测（读 0x08000000 起 0x1244 字节）：地址走到 0x08001000 时**绕回了 0x08000000**
   *    —— 也就是 **4KB 边界回绕**（TAR[11:0] 清零、高位不变）。后果：
   *      · 读：偏移 0x1000 之后读到的是本 4KB 页开头的数据（校验因此误报"读到 0x0"）；
   *      · 写：**写进错误地址**（本该写的没写对）——"固件能写入、某个寄存器写不进去"就有它一份。
   *    所以：块大小按 1KB 收窄（保守），并且**每当新块正好落在 4KB 边界上就重写一次 TAR**。
   *    （很多人以为只有 1KB 回绕，实测这颗探针/这条 AHB-AP 是 4KB。）
   */
  _wordsToBoundary(a){
    const next = (a + 1024) & ~1023;          // 下一个 1KB 边界
    return Math.max(0, (next - a) >> 2);
  }

  /** 块起始落在 4KB 边界上时必须重设 TAR（自增在那儿会绕回页首） */
  _needsTarReset(a, start){
    return a !== start && (a & 0xfff) === 0;
  }

  /**
   * 写目标内存。写完**回读确认**，不一致就重写一次（最多一次）。
   *
   * 🚨 为什么值得多花这一趟：这颗探针的写偶发不落地（posted 写 + 地址自增的锅），
   *    而"写了没生效"在下游的表现千奇百怪 —— RTT 下行命令石沉大海、
   *    flashloader 参数寄存器写丢导致算法跑飞。回读一遍就能发现并补救。
   *    只影响 RAM/调试寄存器的写（都是幂等的），不会对 flash 重复编程。
   */
  async writeMem(addr, bytes, apIndex = 0){
    return await this._withLock(() => this._writeMemLocked(addr, bytes, apIndex));
  }

  async _writeMemLocked(addr, bytes, apIndex = 0){
    addr = addr >>> 0;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!data.length) return;
    await this._writeMemOnce(addr, data, apIndex);
    if (this.verifyWrites === false) return;      // 排障开关（默认开）
    /**
     * 回读确认的**节流**：同一地址短时间内反复写（RTT 轮询每轮推进一次 RdOff 就是这种）
     * 时跳过回读 —— 上一次已经证明这条路径可靠，而每轮多两次往返会把吞吐砍掉两成
     * （实测 330 KB/s 的历史值就是这么丢的）。换地址的写（真正的"配置/参数"写）照旧校验。
     */
    const now = Date.now();
    if (this._lastWriteAddr === addr && now - (this._lastWriteAt || 0) < 200) return;
    this._lastWriteAddr = addr; this._lastWriteAt = now;
    try {
      const back = await this.readMem(addr, data.length, apIndex);
      let same = back.length === data.length;
      if (same) for (let i = 0; i < data.length; i++){ if (back[i] !== data[i]){ same = false; break; } }
      if (!same){
        console.warn(`[dap] 写 0x${addr.toString(16)}（${data.length}B）回读不一致，重写一次`);
        await this._writeMemOnce(addr, data, apIndex);
      }
    } catch (e){ /* 回读失败不阻断写（可能只是读抖动） */ }
  }

  async _writeMemOnce(addr, data, apIndex = 0){
    if ((addr & 3) === 0 && (data.length & 3) === 0){
      const words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
      await this._setTAR(addr, apIndex);
      let i = 0;
      while (i < words.length){
        const n = Math.min(this.maxWords, words.length - i, this._wordsToBoundary(addr + i * 4));
        if (n <= 0 || this._needsTarReset(addr + i * 4, addr)) await this._setTAR(addr + i * 4, apIndex);
        await this._transferBlock(false, n, AP_DRW, words.subarray(i, i + n), apIndex);
        i += n;
      }
      return;
    }
    // 非对齐 → 读-改-写（RTT 下行缓冲的写指针可能不是 4 的倍数）
    const start = (addr & ~3) >>> 0;
    const end = ((addr + data.length + 3) & ~3) >>> 0;
    const cur = await this.readMem(start, end - start, apIndex);
    cur.set(data, addr - start);
    const words = new Uint32Array(cur.buffer, cur.byteOffset, cur.length >> 2);
    await this._setTAR(start, apIndex);
    let i = 0;
    while (i < words.length){
      const n = Math.min(this.maxWords, words.length - i, this._wordsToBoundary(start + i * 4));
      if (n <= 0 || this._needsTarReset(start + i * 4, start)) await this._setTAR(start + i * 4, apIndex);
      await this._transferBlock(false, n, AP_DRW, words.subarray(i, i + n), apIndex);
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
   * 注：DHCSR 在 AP0（AHB-AP）经 PPB 总线可达，与 RAM 同一条 AP——但必须吃 _setTAR
   *    里的屏障读，否则 TAR 竞态会让写丢失/读回 0（烧录器的寄存器访问曾栽在这里）。
   */
  async _dhcsr(value){
    await this._setTAR(0xE000EDF0);
    await this._transferBlock(false, 1, AP_DRW, Uint32Array.of(value >>> 0));
  }

  /** 读一个 32 位字（内部用；地址已归一化） */
  async _readWord(addr){
    const b = await this.readMem(addr, 4);
    return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
  }

  /**
   * 运行/停止目标。
   * 写完**回读确认**（这颗探针的 AP 写偶发不落地），但确认失败**只警告不抛错**：
   * 读回来的 DHCSR 本身也可能是滞后的旧值（实测内核明明在跑、回读却说 C_HALT=1），
   * 为此中断整个烧录流程不划算 —— 真正的判据交给调用方（如 flashloader 的 isHalted 轮询）。
   */
  async run(){
    for (let i = 0; i < 3; i++){
      await this._dhcsr(0xA05F0001);                       // C_DEBUGEN=1, C_HALT=0
      const v = await this._readWord(0xE000EDF0);
      if (((v >>> 1) & 1) === 0) return;                   // C_HALT=0：确实在跑
      await sleep(10);
    }
    console.warn('[dap] 让目标运行的回读一直显示 C_HALT=1（可能是读滞后）——继续，不中断流程');
  }
  async halt(){
    for (let i = 0; i < 3; i++){
      await this._dhcsr(0xA05F0003);                       // C_DEBUGEN=1, C_HALT=1
      const v = await this._readWord(0xE000EDF0);
      if (((v >>> 1) & 1) === 1) return;                   // C_HALT=1：确实停住了
      await sleep(10);
    }
    console.warn('[dap] 停住目标的回读一直显示 C_HALT=0（可能是读滞后）——继续，不中断流程');
  }
  /** @returns {Promise<boolean>} 目标当前是否处于 halt（DHCSR.S_HALT = bit17） */
  async isHalted(){
    try {
      const v = await this._readWord(0xE000EDF0);
      return ((v >>> 17) & 1) === 1;
    } catch { return false; }
  }

  /** 内核寄存器读写（AP0 的 DCRSR/DCRDR，flashloader 执行器用；DCRSR 写完要等 S_REGRDY） */  async regRead(regsel){
    await this.writeMem(0xE000EDF4, new Uint8Array([regsel & 0x1f, 0, 0, 0]));
    for (let i = 0; i < 50; i++){
      const b = await this.readMem(0xE000EDF0, 4);
      if (b[2] & 0x01) break;                        // DHCSR.S_REGRDY = bit16（字节 2 的 bit0）
      await sleep(2);
    }
    const b = await this.readMem(0xE000EDF8, 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  async regWrite(regsel, value){
    await this.writeMem(0xE000EDF8, u32leBytes(value >>> 0));
    await this.writeMem(0xE000EDF4, u32leBytes((regsel & 0x1f) | 0x10000));
    for (let i = 0; i < 50; i++){
      const b = await this.readMem(0xE000EDF0, 4);
      if (b[2] & 0x01) return;
      await sleep(2);
    }
    throw new Error('调试寄存器同步超时（S_REGRDY 没置位）');
  }

  /**
   * 跑 flash 算法之前把中断摁住（SysTick + 全部 NVIC IRQ）。
   *
   * 🚨 为什么必须：擦除**第一个扇区就是向量表**，向量表一旦为空，任何一个中断
   *    （固件的 SysTick 每 1ms 一次）都会让内核取到 0xFFFFFFFF → HardFault → 而 HardFault
   *    向量也空了 → **LOCKUP**。进 LOCKUP 之后 DHCSR.C_HALT 清不掉，只能复位，
   *    现象就是烧录中途报「无法让目标继续运行（DHCSR.C_HALT 清不掉）」。
   *    （pyOCD/J-Link 跑算法时同样会先把中断关掉。）
   * 只是临时摁住：烧完（或失败）都会复位目标，固件重新初始化，不受影响。
   */
  async maskInterrupts(){
    await this.writeMem(0xE000E010, u32leBytes(0));                                  // SysTick：ENABLE/TICKINT 全关
    for (let i = 0; i < 8; i++) await this.writeMem(0xE000E180 + i * 4, u32leBytes(0xFFFFFFFF));  // NVIC ICER0..7
  }

  /**
   * 软复位目标：写 AIRCR.SYSRESETREQ（0xE000ED0C = 0x05FA0004）。
   *
   * 🚨 为什么需要它：`reset()` 拉的是探针的 **nRESET 引脚**，很多接线（本机这块 F103 就是）
   *    根本没把 NRST 连到探针 —— 于是"复位"看着成功，其实目标一直在跑；
   *    更糟的是内核一旦进了 **LOCKUP**（擦除先擦掉向量表 + 中断进来就会），
   *    拉 NRST（没接线）救不回来，DHCSR.C_HALT 也清不掉，只能靠 SYSRESETREQ 或断电。
   *    写 AIRCR 走的是内核寄存器，一定能到。
   */
  async sysReset(){
    await this.writeMem(0xE000ED0C, u32leBytes(0x05FA0004));
    await sleep(60);
    await this._targetInit();
    return '软件复位（AIRCR.SYSRESETREQ）';
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
    // 🚨 有过超时的会话必须先做端口复位：挂起的 bulk 传输不会随 close() 消失，
    //    留着它下一次会话（甚至烧录器的 getDevices()）就会被卡住。
    if (dirty.has(this.device)) await resetDevice(this.device);
    try { await this.device.close(); } catch {}
    this._ready = false;
  }

  /**
   * 自愈：SWD 访问报 FAULT / NO ACK 时重新初始化调试口。
   * 幂等 —— 重连 SWD、重新给 DP 上电、重设 CSW；目标被停住就让它跑。
   * ⚠️ 中途**不要**用 DAP_Disconnect/Connect 去"重连"（实测会把链路搞成一路 NO ACK），
   *    要恢复就重新走 _targetInit()，实在不行只能重新打开 USB 设备。
   *    （_targetInit 内部已经带「纯上电失败 → 掉电-上电」的最后手段，这里不必再补。）
   */
  async recover(){
    await this._targetInit();
    try { if (await this.isHalted()) await this.run(); } catch {}
    return true;
  }
}
