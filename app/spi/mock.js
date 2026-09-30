/**
 * 假探针 —— 没有硬件也能把整条链路跑通（`#scope` 页的 MockScopeProbe 同一思路）。
 *
 *   · HID 侧：实现 `0x35` 的 9 个 action，**响应布局逐字节照固件**（spi_bridge.c:1460-1637），
 *     页面能用它验证组包/解析；`actual_sclk` 用一个简化的分频模型算（跟真板会差一点，
 *     它是给页面显示用的，不是标定值）。
 *   · bulk 侧：按固件的**同样规则**收包解析（`parsePack`）+ 执行帧，并记录"线上字节"，
 *     所以"档位展开对不对""打包器有没有把帧切成跨包"都能离线断言。
 *   · 末级器件：`opts.flash`（缺省就挂一颗 W25Q128 的模型，见 flash.js 的 FlashDevice）——
 *     **纯读/纯写**的 XFER 交给它答（RDID/SFDP/读/擦/写都能离线跑通），
 *     **全双工（tx 与 rx 都非 0）**仍走回环模型（回环自检就靠这个形状）。
 *
 * 它同时演 HID 与 bulk 两个角色 —— 页面里**必须**把两边指向同一个实例（`#scope` 页踩过：
 * 两个实例会造出"配置发给了 A、数据从 B 出来"的假象）。
 *
 * 故障注入（自测错误路径）：`loopback=false`（没接回环跳线，读回 0x00）、`dropRsp`、
 * `forceStatus`、`inFull`、`nakWhenDisabled`。
 */
import {
  ACT, AUXIN_TE, CFG_LEN, CFG_FLAG, F, FRAME_MAX, HID_CMD, LINE, MAGIC, PKT, PROFILE_LEN,
  R, ST, T, TC, XFER_HDR, lineActiveLow, parsePack,
} from './protocol.js';
import { FlashDevice } from './flash.js';

/** 逻辑引脚默认电平（RST/CS 低有效 → 空闲为高）*/
const PIN_IDLE = { dc: 0, rst: 1, csAux: 1, bl: 0, te: 0 };

/** IN 环的槽数（= 固件 in_ring_kb / 512；8 KB / 512 = 16）。满的时候固件暂停消费帧。 */
export const IN_RING_SLOTS = 16;

/** 简化版 sb_pick_sclk：模块时钟源（PLL0 三路）整数分频里挑最接近的（分频必须是偶数）*/
export function mockPickSclk(wantHz){
  const want = wantHz || 20000000;
  let best = 0, bestDiff = Infinity;
  for (const src of [720e6, 600e6, 400e6]){
    for (let n = 2; n <= 512; n += 2){
      const hz = src / n;
      const diff = Math.abs(hz - want);
      if (diff < bestDiff){ bestDiff = diff; best = hz; }
    }
  }
  return Math.round(best);
}

export class MockSpiProbe {
  constructor(opts = {}){
    this.opts = opts;
    this.now = opts.clock || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

    /** 配置块：默认值照固件 spi_bridge.c:1365-1382 */
    this.cfg = {
      sclkHz: 0, mode: 0, bits: 8, csPolicy: 0, txDmaThreshold: 100,
      padDc: 1 /*PB11*/, padRst: 2 /*PB12*/, padCsAux: 4 /*PB10*/, padBl: 3 /*PB13*/, padTe: 4,
      padActiveLow: 0x06 /*RST+CS 低有效*/, padLowRaw: 0x06, flags: CFG_FLAG.CLEAR_ON_ENABLE,
      reserved0: 0, outRingKb: 16, inRingKb: 8, maxFrameBytes: FRAME_MAX,
    };
    this.profile = { profile: 0, defLines: 1, dcActiveHigh: 1, csHoldInStep: 1, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3, flags: 0 };

    this.enabled = false;
    this.actualSclk = 0;
    this.stats = { framesOk: 0, framesErr: 0, bytesTx: 0, bytesRx: 0, txPoll: 0, txDma: 0, outOverrun: 0, inDrop: 0 };
    this.lastErr = ST.OK;

    this.pins = { ...PIN_IDLE };
    this.cs = false;
    this.csWindows = 0;         // 统计"CS 窗口"（每帧一次，用来验 CS 策略）
    this.queue = [];            // 待执行帧（被 DELAY 挡住时留在这里）
    this.blockUntil = 0;        // 非阻塞延时的"下一个允许时刻"
    this.rsps = [];             // 待主机取走的应答包
    this.wire = [];             // 线上字节（XFER 的 tx、STEP 的展开结果）—— 自测对账用
    this.wireLog = [];          // 每个动作的可读记录
    this.hidCalls = [];         // HID 调用流水
    this.delays = [];           // 收到的 DELAY/RESET/STEP.delay
    this.nakWrites = 0;         // 未使能时主机的写（真固件会 NAK）

    /** 末级器件：缺省挂一颗 NOR（RDID/SFDP/读/擦/写都能离线跑通）。`flash:false` 可关掉 */
    this.flash = opts.flash === false ? null
      : opts.flash instanceof FlashDevice ? opts.flash
      : new FlashDevice({ ...(opts.flash && typeof opts.flash === 'object' ? opts.flash : {}), clock: this.now });
    this.flashNotes = [];       // 器件侧拒绝/说明（模型给的，不是协议错）

    /** 故障注入 */
    this.faults = {
      loopback: opts.loopback !== false,   // 默认接好了 MOSI↔MISO 跳线
      dropRsp: false,                      // 应答直接不回（模拟丢包）
      forceStatus: null,                   // 下一帧强制返回这个状态码（一次性）
      inFull: false,                       // IN 环满：应答被丢 + in_drop++
      disabledAlways: false,               // 假装"使能不上"（ENABLE 无效）
    };
    if (opts.faults) Object.assign(this.faults, opts.faults);
  }

  // ======================================================================== HID 侧

  /** 与 `AkaLinkHid.xfer(cmd, data)` 同形：返回 63 B 的 payload（[1]=cmd、[2]=action、[3..]=数据）*/
  async xfer(cmd, data, timeoutMs = 3000){
    void timeoutMs;
    const d = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    const action = d[0] | 0;
    this.hidCalls.push({ cmd, action, data: Uint8Array.from(d) });
    const res = new Uint8Array(63);
    res[1] = cmd & 0xff;
    res[2] = action & 0xff;
    if (cmd !== HID_CMD) return res;

    switch (action){
      case ACT.STATUS: {
        res[0] = 44;
        const dv = new DataView(res.buffer);
        dv.setUint32(3, this.statusWord(), true);
        dv.setUint32(7, this.stats.framesOk, true);
        dv.setUint32(11, this.stats.bytesTx, true);
        dv.setUint32(15, this.stats.bytesRx, true);
        dv.setUint32(19, this.stats.txPoll, true);
        dv.setUint32(23, this.stats.txDma, true);
        dv.setUint32(27, this.stats.outOverrun, true);
        dv.setUint32(31, this.stats.inDrop, true);
        dv.setUint32(35, this.actualSclk, true);
        dv.setUint32(39, this.stats.framesErr, true);
        break;
      }
      case ACT.ENABLE: {
        const on = !!d[1] && !this.faults.disabledAlways;
        this.enabled = on;
        if (on && (this.cfg.flags & CFG_FLAG.CLEAR_ON_ENABLE)) this._clear();
        this.actualSclk = on ? mockPickSclk(this.cfg.sclkHz) : 0;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      }
      case ACT.RESET:
        this._clear();
        this.stats = { framesOk: 0, framesErr: 0, bytesTx: 0, bytesRx: 0, txPoll: 0, txDma: 0, outOverrun: 0, inDrop: 0 };
        this.lastErr = ST.OK;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      case ACT.ABORT:
        this.queue = []; this.rsps = []; this.blockUntil = 0;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      case ACT.SET_CFG: {
        const blob = d.subarray(1, 1 + CFG_LEN);
        const c = this._decodeCfg(blob);
        const bad = this._validateCfg(c);
        if (bad){
          this.lastErr = ST.RANGE;
          res[0] = 8;
          new DataView(res.buffer).setUint32(3, this.statusWord() | (ST.RANGE << 8), true);
          break;
        }
        Object.assign(this.cfg, c, { maxFrameBytes: FRAME_MAX });
        if (this.enabled) this.actualSclk = mockPickSclk(this.cfg.sclkHz);
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      }
      case ACT.GET_CFG: {
        const b = this._encodeCfg();
        res[0] = 4 + CFG_LEN;
        res.set(b, 3);
        break;
      }
      case ACT.PIN_CFG: {
        const line = d[1] | 0, pad = d[2] | 0;
        if (pad < 0 || pad > 13 || (!this._padOk(pad))){
          this.lastErr = ST.RANGE;
          res[0] = 8;
          new DataView(res.buffer).setUint32(3, this.statusWord() | (ST.RANGE << 8), true);
          break;
        }
        const key = { [LINE.DC]: 'padDc', [LINE.RST]: 'padRst', [LINE.CS_AUX]: 'padCsAux', [LINE.BL]: 'padBl', [LINE.TE]: 'padTe' }[line];
        if (key) this.cfg[key] = pad;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      }
      case ACT.SET_PROFILE: {
        const p = d.subarray(1, 1 + PROFILE_LEN);
        const prof = { profile: p[0] > 2 ? 0 : p[0], defLines: [1, 2, 4].includes(p[1]) ? p[1] : 1, dcActiveHigh: !!p[2], csHoldInStep: !!p[3], qspiWrOpcode: p[4], qspiColorOpcode: p[5], qspiAddrBytes: p[6], flags: p[7] };
        this.profile = prof;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      }
      case ACT.GET_PROFILE: {
        const p = this.profile;
        res[0] = 4 + PROFILE_LEN;
        res.set([p.profile, p.defLines, p.dcActiveHigh ? 1 : 0, p.csHoldInStep ? 1 : 0,
                 p.qspiWrOpcode, p.qspiColorOpcode, p.qspiAddrBytes, p.flags, 0, 0, 0, 0, 0, 0, 0, 0], 3);
        break;
      }
      default:
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
    }
    return res;
  }

  statusWord(){
    let w = 0;
    if (this.enabled) w |= 1;
    if (this.queue.length) w |= 2;
    if (this.cs) w |= 4;
    if (this.rsps.length >= IN_RING_SLOTS || this.faults.inFull) w |= 8;   // IN 流控
    if (this.queue.length >= 30) w |= 16;
    w |= (this.lastErr & 0xff) << 8;
    return w >>> 0;
  }

  _clear(){ this.queue = []; this.rsps = []; this.blockUntil = 0; this.cs = false; }

  _padOk(pad){
    const quad = this.profile.profile === 2;
    if (quad && (pad === 12 || pad === 13)) return false;   // PA30/PA31 被 quad 占了
    return true;
  }

  _validateCfg(c){
    if (c.mode > 3) return 'mode';
    if (c.bits !== 8) return 'bits';
    if (c.csPolicy > 3) return 'csPolicy';
    for (const p of [c.padDc, c.padRst, c.padCsAux, c.padBl, c.padTe]) if (p > 13 || !this._padOk(p)) return 'pad';
    return null;
  }

  _encodeCfg(){
    const b = new Uint8Array(CFG_LEN);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, this.cfg.sclkHz >>> 0, true);
    b[4] = this.cfg.mode; b[5] = this.cfg.bits; b[6] = this.cfg.csPolicy; b[7] = this.cfg.txDmaThreshold;
    b[8] = this.cfg.padDc; b[9] = this.cfg.padRst; b[10] = this.cfg.padCsAux; b[11] = this.cfg.padBl;
    b[12] = this.cfg.padActiveLow; b[13] = this.cfg.padTe; b[14] = this.cfg.flags;
    dv.setUint16(16, this.cfg.outRingKb, true); dv.setUint16(18, this.cfg.inRingKb, true);
    dv.setUint16(20, FRAME_MAX, true);
    return b;
  }

  _decodeCfg(b){
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return {
      sclkHz: dv.getUint32(0, true), mode: b[4], bits: b[5], csPolicy: b[6], txDmaThreshold: b[7],
      padDc: b[8], padRst: b[9], padCsAux: b[10], padBl: b[11], padActiveLow: b[12], padTe: b[13],
      padLowRaw: b[12], flags: b[14], reserved0: b[15],
      outRingKb: dv.getUint16(16, true), inRingKb: dv.getUint16(18, true),
    };
  }

  // ======================================================================== bulk 侧

  /**
   * 主机送来一次传输（= 真设备端点被 arm 之后的若干次 OUT 回调）。
   *
   * 🚨 **一次 USB 传输可以带多个 512 B 包**（主机攒批提交，见 `protocol.batchPacks`）：
   *    真固件每次只 arm 一个 512 B 槽（`usbd_ep_start_read(..., SB_PKT_SIZE)`），收满/收到短包就回调一次、
   *    解析这一槽里的帧。所以这里也照同一个口径**按 512 B 拆槽**，一槽一次 `write` 语义 ——
   *    攒批不该改变设备看到的东西，只该让主机少喊几次。
   * 未使能时真固件不 arm 端点 → 会 NAK。
   */
  write(pack){
    const b = pack instanceof Uint8Array ? pack : new Uint8Array(pack);
    if (!this.enabled){ this.nakWrites++; return { accepted: false }; }
    if (b.length > PKT){
      let frames = 0, firstErr = null, residue = 0;
      for (let off = 0; off < b.length; off += PKT){
        const slot = b.subarray(off, Math.min(off + PKT, b.length));
        const r = this._writeSlot(slot);
        frames += r.frames || 0;
        residue += r.residue || 0;
        if (r.err && !firstErr) firstErr = r.err;
      }
      return { accepted: true, frames, residue, err: firstErr, slots: Math.ceil(b.length / PKT) };
    }
    return this._writeSlot(b);
  }

  /** 一个 512 B 槽（= 真固件的一次 OUT 回调）*/
  _writeSlot(b){
    const r = parsePack(b);
    if (r.err){
      this.stats.framesErr++;
      this.lastErr = r.err.why === 'bad_magic' ? ST.BAD_MAGIC : ST.BAD_FRAME;
      this.wireLog.push(`包被丢：${r.err.why}@${r.err.off}`);
      return { accepted: true, frames: 0, err: r.err };
    }
    for (const f of r.frames) this.queue.push(f);
    this._drain();
    return { accepted: true, frames: r.frames.length, residue: r.residue };
  }

  /** 时间推进（transport 定期调用）：把被非阻塞延时挡住的帧继续执行 */
  tick(nowMs){
    const now = nowMs ?? this.now();
    if (this.queue.length && now >= this.blockUntil) this._drain(now);
  }

  /** 主机取走一个应答包（= IN 端点读）*/
  takeRsp(){ return this.rsps.shift() || null; }

  _drain(now = this.now()){
    while (this.queue.length){
      if (now < this.blockUntil) return;              // 非阻塞延时：到点再继续
      const f = this.queue[0];
      /**
       * IN 环满 = **不消费这一帧**，等主机取走数据（照固件 `sb_in_alloc()==NULL` 的分支，
       * spi_bridge.c:1562-1568：`return; /* IN 环满：不消费这一帧，等主机取走数据 *\/`）。
       * 固件**从不丢应答** —— 早先这里模拟成"挤掉最老的"，会让一包 25 条带 RSP 的读帧
       * 在假探针上假失败（真机上只会暂停一下，等主机把 IN 读走）。
       */
      if ((f.flags & F.RSP) && this.rsps.length >= IN_RING_SLOTS) return;
      this.queue.shift();
      const st = this._exec(f, now);
      // 自动 CS 模式下"每帧一个 CS 窗口"，带 CS_HOLD 的帧结束后**不释放**（管道化刷像素就靠这个）
      if (st === ST.OK && (f.type === T.XFER || f.type === T.STEP)) this._csAfterFrame(f.flags);
      if (st === ST.OK) this.stats.framesOk++;
      else { this.stats.framesErr++; this.lastErr = st; }
      if (f.flags & F.RSP){
        if (this.faults.dropRsp) { /* 丢包：什么都不回 */ }
        else if (this.faults.inFull){ this.stats.inDrop++; this._rsp(ST.IN_FULL, f.seq, new Uint8Array(0)); }
        else this._rsp(st, f.seq, this._lastRx || new Uint8Array(0));
      } else if (st !== ST.OK){
        this._rsp(st, f.seq, new Uint8Array(0), R.EVT);
      }
      this._lastRx = null;
    }
  }

  /** 自动 CS 模式的窗口语义：本帧开始时若 CS 未占用就开一个新窗口；不带 CS_HOLD 就释放 */
  _csAfterFrame(flags){
    if (!this.cs){ this.cs = true; this.csWindows++; }
    if (!(flags & F.CS_HOLD)) this.cs = false;
  }

  _rsp(status, seq, data, type = R.RSP){
    const forced = this.faults.forceStatus;
    if (forced != null){ status = forced; this.faults.forceStatus = null; }
    const d = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    const out = new Uint8Array(8 + d.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, MAGIC, true); out[2] = type; out[3] = status;
    dv.setUint16(4, seq, true); dv.setUint16(6, d.length, true);
    out.set(d, 8);
    this.rsps.push(out);
    if (this.rsps.length > 16){ this.rsps.shift(); this.stats.inDrop++; }
  }

  /** 执行一帧；返回 sb_status_t。读到的数据放 this._lastRx（应答时取走）*/
  _exec(f, now){
    const p = f.payload;
    switch (f.type){
      case T.PING:
        return ST.OK;

      case T.DELAY: {
        const us = p.length >= 4 ? new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, true) : 0;
        this.delays.push(us / 1000);            // ⚠️ 统一记**毫秒**（DELAY 帧给的是微秒）
        this.blockUntil = Math.max(this.blockUntil, now + us / 1000);
        return ST.OK;
      }

      case T.CFG: {
        if (p[0] === 0) this.cfg.txDmaThreshold = p[1] | ((p[2] || 0) << 8);
        return ST.OK;
      }

      case T.CS: {
        const assert = !!p[0];
        if (assert && !this.cs){ this.cs = true; this.csWindows++; }
        if (!assert){ this.cs = false; this.flash?.releaseCs(); }
        return ST.OK;
      }

      case T.GPIO: {
        const line = p[0] | 0, lvl = p[1] ? 1 : 0;
        const key = { [LINE.DC]: 'dc', [LINE.RST]: 'rst', [LINE.CS_AUX]: 'csAux', [LINE.BL]: 'bl' }[line];
        if (!key) return ST.GPIO;
        const activeLow = lineActiveLow(this.cfg.padActiveLow, line);
        this.pins[key] = activeLow ? (lvl ? 0 : 1) : lvl;   // 记录**物理**电平
        this.wireLog.push(`GPIO ${key}=${lvl}`);
        return ST.OK;
      }

      case T.RESET: {
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const low = dv.getUint16(0, true), post = dv.getUint16(2, true);
        this.pins.rst = 0; this.pins.rst = 1;
        this.delays.push(low + post);           // 毫秒（与 DELAY 帧同一个口径）
        this.blockUntil = Math.max(this.blockUntil, now + (low + post));
        this.wireLog.push(`RESET low=${low}ms post=${post}ms`);
        return ST.OK;
      }

      case T.AUX_IN:
        this._lastRx = Uint8Array.of(this.pins.te ? AUXIN_TE : 0);
        return ST.OK;

      case T.STEP:
        return this._execStep(p, now);

      case T.XFER:
        return this._execXfer(f, p);

      default:
        return ST.BAD_FRAME;
    }
  }

  /** 档位展开：0 raw / 1 spi_dcx / 2 qspi（照固件 spi_bridge.c:744-801 的语义）*/
  _execStep(p, now){
    if (p.length < 4) return ST.BAD_FRAME;
    const cmd = p[0], n = p[1];
    const delayMs = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(2, true);
    if (4 + n > p.length) return ST.BAD_FRAME;
    const params = p.subarray(4, 4 + n);
    const prof = this.profile;
    const bytes = [];
    if (prof.profile === 2){
      bytes.push(prof.qspiWrOpcode, cmd, 0x00, 0x00, ...params);      // opcode + 24 bit 地址(=命令字<<16) + 参数
    } else if (prof.profile === 1){
      bytes.push(cmd, ...params);                                     // 命令(DC=0) → 翻 DC → 参数(DC=1)
    } else {
      bytes.push(cmd, ...params);                                     // raw：cmd + params 同线数
    }
    this.wire.push(Uint8Array.from(bytes));
    this.wireLog.push(`STEP cmd=0x${cmd.toString(16).padStart(2, '0')} n=${n}` +
      (prof.profile === 1 ? '（DC 0→1，同一 CS 窗口）' : prof.profile === 2 ? '（0x02 + 24bit 地址）' : ''));
    this.stats.bytesTx += bytes.length;
    this.stats.txPoll++;
    if (delayMs > 0){ this.delays.push(delayMs); this.blockUntil = Math.max(this.blockUntil, now + delayMs); }
    return ST.OK;
  }

  _execXfer(f, p){
    if (p.length < XFER_HDR) return ST.BAD_FRAME;
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const tcfg = p[1], txLen = dv.getUint16(4, true), rxLen = dv.getUint16(6, true);
    const cmdEn = !!(tcfg & TC.CMD_EN), addrEn = !!(tcfg & TC.ADDR_EN) && p[2] > 0;
    if (txLen + XFER_HDR > p.length) return ST.BAD_FRAME;
    if (rxLen > FRAME_MAX) return ST.RANGE;
    if (rxLen && !(f.flags & F.RSP)) return ST.BAD_FRAME;           // 读数据必须带 RSP
    if (txLen && rxLen && txLen !== rxLen) return ST.RANGE;         // 全双工要求等长
    if (!cmdEn && !addrEn && !txLen && !rxLen) return ST.BAD_FRAME;

    const tx = p.subarray(XFER_HDR, XFER_HDR + txLen);
    if (txLen){ this.wire.push(Uint8Array.from(tx)); this.stats.bytesTx += txLen; this.stats.txPoll++; }
    if (tcfg & TC.DC_EN) this.pins.dc = (tcfg & TC.DC_LEVEL) ? 1 : 0;

    // 器件模型：**纯读 / 纯写**（不含全双工）交给它；全双工仍走回环 —— 回环自检就靠那个形状
    const duplex = txLen > 0 && rxLen > 0;
    if (this.flash && !duplex && (cmdEn || addrEn || rxLen)){
      const r = this.flash.exec({
        cmd: p[0], cmdEn, addr: dv.getUint32(8, true), addrEn,
        dummy: p[3], lines: (tcfg & TC.LINES_MASK) === TC.LINES_4 ? 4 : (tcfg & TC.LINES_MASK) === TC.LINES_2 ? 2 : 1,
        tx, rxLen, csHold: !!(f.flags & F.CS_HOLD),
      });
      if (r.rx){ this._lastRx = r.rx; this.stats.bytesRx += r.rx.length; }
      if (r.why){ this.flashNotes.push(r.why); this.wireLog.push(`器件：${r.why}`); }
      this.wireLog.push(`XFER cmd=0x${p[0].toString(16).padStart(2, '0')} tx=${txLen} rx=${rxLen}` +
        `${cmdEn ? '' : '（续读）'}${(f.flags & F.CS_HOLD) ? ' CS_HOLD' : ''} → 器件`);
      return ST.OK;
    }

    if (rxLen){
      this.stats.bytesRx += rxLen;
      // 回环模型：接好跳线时读回 = 刚发出去的；没接就是 0x00/0xFF
      const rx = new Uint8Array(rxLen);
      if (this.faults.loopback) rx.set(tx.subarray(0, Math.min(txLen, rxLen)));
      else rx.fill(0x00);
      this._lastRx = rx;
    }
    this.wireLog.push(`XFER cmd=0x${p[0].toString(16).padStart(2, '0')} tx=${txLen} rx=${rxLen}` +
      ((f.flags & F.CS_HOLD) ? ' CS_HOLD' : ''));
    return ST.OK;
  }

  // ======================================================================== 自测辅助

  /** 复位到干净状态（不动配置）*/
  resetState(){ this._clear(); this.stats = { framesOk: 0, framesErr: 0, bytesTx: 0, bytesRx: 0, txPoll: 0, txDma: 0, outOverrun: 0, inDrop: 0 }; this.wire = []; this.wireLog = []; this.hidCalls = []; this.delays = []; }

  /** 线上字节（所有 STEP/ XFER 的 tx 按顺序拼起来）—— 档位展开的对账口径 */
  wireHex(){ return this.wire.map(w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ')).join(' | '); }
}
