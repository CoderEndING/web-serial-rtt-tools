/**
 * akaLinkPro 自定义 HID 配置通道（WebHID）—— 纯协议，不碰 DOM。
 *
 * 协议出处（探针固件仓库，以源码为准）：
 *   E:\Share\github\akaLinkPro\firmware\application_5301\Custom HID Protocol.md
 *   E:\Share\github\akaLinkPro\firmware\application_5301\src\api\api_param.c
 *
 * 报文固定 64 字节，byte[0] = Report ID（1 = 主机→设备，2 = 设备→主机）。
 * WebHID 把 Report ID 单独传（sendReport(id, payload) / inputreport 事件），所以这里操作的是
 * **63 字节 payload**：
 *     payload[0] = Data Length（Command 1 字节 + 有效数据；固件其实不校验，照文档填）
 *     payload[1] = Command
 *     payload[2..] = 数据
 * 0x31（探针侧 RTT 桥）响应：payload[2] = 返回码，payload[3..] = 12 个 32 位小端状态字。
 */

export const USAGE_PAGE = 0xFF00;   // 厂商自定义页
export const VID = 0x0d28;          // akaLinkPro：CMSIS-DAP + CDC + HID + WebUSB + DFU 复合设备
export const PID = 0x0204;
export const PAYLOAD = 63;          // 64 - 1（Report ID）

export const CMD = {
  GET_CONFIG: 0x01, SET_CONFIG: 0x02, GET_VOLTAGE: 0x03, SAVE_CONFIG: 0x04,
  MODEL: 0x10, SN: 0x11, HW_VER: 0x12, FW_VER: 0x13, BL_VER: 0x14,
  HW_DATE: 0x15, FW_DATE: 0x16, BL_DATE: 0x17,
  RTT: 0x31,
  RESET: 0xfe, DFU: 0xff,
};

/** 0x31 的动作码（api_param.c 的 RTT_ACT_*，与文档一致） */
export const RTT_ACT = {
  STOP: 0, START: 1, STATUS: 2, AUTOSTART: 3, RAW_DAP: 4, PEEK: 5,
  RAW_RESULT: 6, CONFIG: 7, BENCH: 8, BENCH_RESULT: 9,
};

// ============================================================================
// 组包 / 解析（导出成纯函数，Node 自测直接测）
// ============================================================================

/** 组一条请求 → 63 字节 payload */
export function buildRequest(cmd, data = new Uint8Array(0), lenOverride){
  const p = new Uint8Array(PAYLOAD);
  p[0] = (lenOverride ?? (1 + data.length)) & 0xff;
  p[1] = cmd & 0xff;
  p.set(data.subarray(0, PAYLOAD - 2), 2);
  return p;
}

/** 0x31 的 data 段：action + 目标地址(4) + 搜索长度(4) + 通道 —— 对应 req_hid[3..12] */
export function rttData(action, addr = 0, size = 0, channel = 0){
  const d = new Uint8Array(10);
  const dv = new DataView(d.buffer);
  d[0] = action & 0xff;
  dv.setUint32(1, addr >>> 0, true);
  dv.setUint32(5, size >>> 0, true);
  d[9] = channel & 0xff;
  return d;
}

/**
 * action=7 运行时调参的 data 段（按固件的 req_hid 布局，**同样以 action 字节开头**）：
 *   [0]=action  [1..4]=SWD 时钟 Hz  [5..6]=块读字节  [7]=标志(bit0=丢弃)  [8]=delay 覆盖
 */
export function rttConfigData({ clockHz = 0, chunkBytes = 0, discard = false, delayOverride = 0xff } = {}){
  const d = new Uint8Array(9);
  const dv = new DataView(d.buffer);
  d[0] = RTT_ACT.CONFIG;
  dv.setUint32(1, clockHz >>> 0, true);
  dv.setUint16(5, chunkBytes & 0xffff, true);
  d[7] = discard ? 1 : 0;
  d[8] = delayOverride & 0xff;
  return d;
}

const s8 = v => (v & 0xff) > 127 ? (v & 0xff) - 256 : (v & 0xff);

/**
 * 12 个状态字（48 字节）→ 好用的对象。字序与位域见协议文档「状态字」表。
 */
export function parseStatus(bytes){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = i => dv.getUint32(i * 4, true);
  const [w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11] =
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(w);
  return {
    running: !!(w0 & 1),
    channel: (w0 >>> 8) & 0xff,
    swdReady: !!(w0 & (1 << 16)),
    clockDelay: (w0 >>> 24) & 0xff,
    cbAddr: w1,                 // 找到的控制块地址（"SEGGER RTT" 签名处）
    upAddr: w2,                 // 上行缓冲描述符地址
    moved: w3,                  // 已搬运字节（每次启动清零）
    polls: w4 & 0xffff,
    transfers: w4 >>> 16,
    rdErr: w5 & 0xffff,         // 目标内存读错误
    wrErr: w5 >>> 16,           // RdOff 写错误
    lastChunk: w6 & 0xffff,
    emptyRing: w6 >>> 16,
    dapYield: w7 & 0xffff,      // 给 DAP 让路次数
    rescans: w7 >>> 16,
    lastCmdId: w8 & 0xff,
    lastResp: w9,
    startRc: s8(w10),           // 最近一次启动的返回码
    chunkBytes: w11 & 0xffff,
    discard: !!(w11 & (1 << 16)),
    swdMhz: (w11 >>> 24) & 0xff,
  };
}

/** 启动返回码 → 人话（固件：-1 SWJ_Clock 失败 / -2 SWD 初始化失败 / -3 没找到控制块） */
export function startRcText(rc){
  switch (rc){
    case 0: return '正常';
    case -100: return '启动中（探针还在排队，结果没出来）';   // 固件里 s_start_rc 的初值 = -100
    case -1: return 'SWD 时钟设置失败（换低一档试试）';
    case -2: return 'SWD 初始化失败（查接线 / 目标供电 / 复位）';
    case -3: return '没找到 RTT 控制块（地址区间不对？Cortex-M7 要给 AXI SRAM）';
    case -4: return '该档位链路不可用';
    default: return `未知返回码 ${rc}`;
  }
}

/** -100 = 固件里"还没启动过/结果待定"的哨兵值，不是错误 */
export const START_PENDING = -100;

/** payload[2..] 里以 \0 结尾的 ASCII */
export function ascii(bytes){
  let s = '';
  for (const b of bytes){ if (!b) break; s += String.fromCharCode(b); }
  return s.replace(/\0+$/, '').trim();
}

// ============================================================================
// WebHID 客户端
// ============================================================================

export class AkaLinkHid {
  constructor(){
    this.device = null;
    this._pending = null;
    this.onDisconnect = null;
    this._onInput = this._handleInput.bind(this);
    this._onDisc = this._handleDisconnect.bind(this);
  }

  static supported(){ return typeof navigator !== 'undefined' && !!navigator.hid; }
  get connected(){ return !!(this.device && this.device.opened); }
  get label(){
    const d = this.device;
    if (!d) return '';
    return [d.productName || 'akaLinkPro', d.serialNumber ? '· ' + d.serialNumber : ''].join(' ').trim();
  }

  /** 弹设备选择框（只列 vendor-defined HID：usage page 0xFF00，也就是探针那个 HID 接口） */
  async request(){
    if (!AkaLinkHid.supported()) throw new Error('这个浏览器没有 WebHID（Chrome / Edge 桌面版才有）');
    const devs = await navigator.hid.requestDevice({ filters: [{ usagePage: USAGE_PAGE }] });
    if (!devs.length) throw new Error('没有选择设备');
    await this.open(devs[0]);
    return this.device;
  }

  /** 用之前授权过的设备直接连（浏览器记住过就不用再点弹框） */
  async reconnect(){
    if (!AkaLinkHid.supported()) throw new Error('这个浏览器没有 WebHID（Chrome / Edge 桌面版才有）');
    const devs = await navigator.hid.getDevices();
    const d = devs.find(x => x.collections?.some(c => c.usagePage === USAGE_PAGE)) || devs[0];
    if (!d) throw new Error('没有已授权的探针（先点一次「连接探针」）');
    await this.open(d);
    return d;
  }

  async open(device){
    if (this.device && this.device !== device) await this.close();
    if (!device.opened) await device.open();
    this.device = device;
    device.addEventListener('inputreport', this._onInput);
    navigator.hid.addEventListener('disconnect', this._onDisc);
  }

  async close(){
    const d = this.device;
    this.device = null;
    this._pending = null;
    if (!d) return;
    try { d.removeEventListener('inputreport', this._onInput); } catch {}
    try { navigator.hid.removeEventListener('disconnect', this._onDisc); } catch {}
    try { if (d.opened) await d.close(); } catch {}
  }

  _handleInput(e){
    const p = this._pending;
    if (!p) return;                       // 没人等就算了（比如上一次超时后才回来的包）
    const res = new Uint8Array(e.data.buffer);
    // 迟到的旧响应：**丢掉继续等**（不要拿它去满足新请求 —— 真机上踩过：
    // info() 并发发了 3 条，结果后面那条 AUTOSTART 收到了型号回包，状态字全是垃圾）
    if (res[1] !== p.cmd) return;
    this._pending = null;
    p.resolve(res);
  }

  _handleDisconnect(e){
    if (e.device !== this.device) return;
    this.device = null;
    this._pending = null;
    this.onDisconnect?.();
  }

  /**
   * 重新拿一次设备对象并打开。
   *
   * 为什么要这个：探针**被复位/拔插**之后会重新枚举，浏览器手里那个 `HIDDevice` 就作废了 ——
   * 之后 `sendReport()` 会抛 `Failed to write the report`（本机实测：探针自己重启过一次，
   * 用户点「开始采样」就报这个，而且完全不知道发生了什么）。
   * 重新枚举后 `getDevices()` 会给到**新的**对象，所以这里不是"重开旧的"，是重新取。
   */
  async _reacquire(){
    if (!AkaLinkHid.supported()) throw new Error('这个浏览器没有 WebHID');
    const devs = await navigator.hid.getDevices();
    const d = devs.find(x => x.collections?.some(c => c.usagePage === USAGE_PAGE)) || devs[0];
    if (!d) throw new Error('浏览器里已经没有已授权的探针了（点「连接探针」重新授权一次）');
    await this.open(d);
    return d;
  }

  /** 发一条请求并等回包；同一时刻只允许一条在飞。
   *  写失败（多半是探针被复位/拔插过、句柄过期）时**自动重新取设备再重试一次**；
   *  仍失败则抛出带操作建议的错误 —— 别让用户只看到一句 "Failed to write the report"。 */
  async xfer(cmd, data, timeout = 3000){
    if (!this.connected) throw new Error('探针没连上');
    if (this._pending) throw new Error('上一条请求还没回来');
    const pkt = buildRequest(cmd, data);
    const once = async () => {
      const wait = new Promise((resolve, reject) => {
        this._pending = { cmd, resolve, reject };
        setTimeout(() => {
          if (this._pending && this._pending.cmd === cmd){ this._pending = null; reject(new Error(`探针 ${timeout}ms 没响应`)); }
        }, timeout);
      });
      await this.device.sendReport(1, pkt);
      return await wait;
    };
    try {
      let res;
      try {
        res = await once();
      } catch (e){
        const msg = String(e?.message || e);
        if (!/write the report|disconnect|not.*connected|NetworkError/i.test(msg)) throw e;
        this._pending = null;
        this.reconnects = (this.reconnects || 0) + 1;
        await this._reacquire();                 // 探针重新枚举过：拿新句柄再试
        res = await once();
      }
      return res;                                // res[1] 已保证 === cmd（见 _handleInput）
    } catch (e){
      this._pending = null;
      throw new Error('HID 发送失败：' + (e?.message || e) +
        '（探针很可能刚被**复位/拔插**过 —— 点「重连」；还不行就拔插一次探针）');
    }
  }

  // ---------------- 便捷方法 ----------------

  /** 字符串类命令（型号 / 序列号 / 版本 / 日期） */
  async text(cmd){
    const res = await this.xfer(cmd, undefined, 2000);
    return ascii(res.subarray(2));
  }

  /** 型号 / 固件版本 / 序列号 —— 必须**一条一条**发（探针一次只回一条） */
  async info(){
    const model = await this.text(CMD.MODEL);
    const fw = await this.text(CMD.FW_VER);
    const sn = await this.text(CMD.SN);
    return { model, fw, sn };
  }

  /** 0x31：发一个动作，回 { rc, status } */
  async rtt(action, data, timeout = 3000){
    const res = await this.xfer(CMD.RTT, data || rttData(action), timeout);
    return {
      rc: s8(res[2]),
      status: parseStatus(res.subarray(3, 3 + 48)),
      raw: res,
    };
  }

  start({ addr = 0, size = 0, channel = 0 } = {}){ return this.rtt(RTT_ACT.START, rttData(RTT_ACT.START, addr, size, channel)); }
  autostart(){ return this.rtt(RTT_ACT.AUTOSTART, rttData(RTT_ACT.AUTOSTART)); }
  stop(){ return this.rtt(RTT_ACT.STOP, rttData(RTT_ACT.STOP)); }
  status(){ return this.rtt(RTT_ACT.STATUS, rttData(RTT_ACT.STATUS)); }
  configure(o){ return this.rtt(RTT_ACT.CONFIG, rttConfigData(o)); }
}
