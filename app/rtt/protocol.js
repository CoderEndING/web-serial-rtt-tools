/**
 * SEGGER RTT 主机端协议（与探针解耦：只要给出 readMem/writeMem 就能工作）。
 *
 * 控制块（32 位目标）：
 *   char  acID[16]              "SEGGER RTT\0..."
 *   u32   MaxNumUpBuffers
 *   u32   MaxNumDownBuffers
 *   then  aUp[MaxNumUp]   ，每项 24 字节：
 *         u32 sName; u32 pBuffer; u32 SizeOfBuffer; u32 WrOff; u32 RdOff; u32 Flags;
 *   then  aDown[MaxNumDown]，结构完全相同
 *
 * 上行走 ring buffer：读 [RdOff, WrOff) → 把 RdOff 写成 WrOff（主机是读方）。
 * 下行走反的：主机写数据 + 推进 WrOff（目标是读方）。
 *
 * ⚠️ 与 rtt.py 一致的三个坑：
 *  ① 缓冲是环形，读之前必须判断是否绕回，否则一次只能读到末尾；
 *  ② WrOff/RdOff 要尽量一次性读回来（这里整条 24 字节项一起读），避免撕裂；
 *  ③ 目标写太快会覆盖/丢弃主机没读走的数据（RTT 不重传），但要注意**能观测到什么**：
 *     · 最实用的是「缓冲水位」：每次读到 n 字节，n/(size-1) 就是当时的占用率。
 *       实测（STM32F103 + OpenOCD RPC，读速只有 ~17 KB/s）：目标一次灌 8KB 进 4KB 缓冲、
 *       主机只收到 4KB —— 水位峰值 92%，但**一次都没到 100%**（主机边读边被写）。
 *       所以判据取「水位 ≥ 3/4 记为高位」，比死等 "n == size-1" 实用得多。
 *     · 「精确差值」：主机侧 RdOff 落后于上次排空位置（上次推进失败/读取出错）时，
 *       用「目标写了多少(ΔWr) − 这次读到多少」算得出差值。
 *     · 不可观测：SKIP 模式下目标自己丢掉的数据、或目标在两轮之间写了超过整个缓冲 —— 
 *       模运算已经绕圈，谁也看不出来丢了多少（JLinkRTTViewer 同样不知道）。
 *       界面上的数字都当"下限/压力指示"，不是精确账。
 */
import { u32le, u32leBytes, latin1 } from '../core/bin.js';

export const CB_ID = 'SEGGER RTT';
export const ENTRY = 24;

export class Rtt {
  constructor(mem, opts = {}){
    this.mem = mem;                     // { readMem(addr,len), writeMem(addr,bytes) }
    this.addr = opts.addr || 0;
    this.maxUp = 0; this.maxDown = 0;
    this.upBase = 0; this.downBase = 0;
    this.up = []; this.down = [];
    this._lastWr = new Map();
    this._lost = new Map();
    this._full = new Map();
    this._high = new Map();
    this.peak = 0;
    this._names = new Map();
  }

  // ---------------- 定位控制块 ----------------
  /**
   * 找一个**可信的**控制块：RAM 里出现 "SEGGER RTT" 的地方可能不止一处
   * —— 上一次固件编译留下的旧控制块会残留在 .bss 之外（RAM 不是每次上电都清零），
   * 锁错了就会出现"通道数/缓冲指针全是垃圾"的怪现象（本机实测踩到）。
   * 所以候选地址要逐个校验结构是否合理，第一个通过的就是它。
   */
  static async locate(mem, o = {}){
    const { addr = 0, ranges = [], chunk = 4096, onProgress } = o;
    if (addr){
      const v = await Rtt.validate(mem, addr);
      if (!v.ok) throw new Error(`0x${addr.toString(16)} 处不是可用的 RTT 控制块：${v.reason}`);
      return addr;
    }
    let done = 0;
    const total = ranges.reduce((s, r) => s + (r.end - r.start), 0) || 1;
    const tried = [];
    for (const r of ranges){
      for (let a = r.start; a < r.end; a += chunk - (CB_ID.length - 1)){
        const n = Math.min(chunk, r.end - a);
        if (n < 16) break;
        let buf;
        try { buf = await mem.readMem(a, n); }
        catch { buf = new Uint8Array(0); }          // 该段不可读（没映射）就跳过
        const s = latin1(buf);
        let i = s.indexOf(CB_ID);
        while (i >= 0){
          const cand = a + i;
          const v = await Rtt.validate(mem, cand);
          if (v.ok) return cand;
          tried.push({ addr: cand, reason: v.reason });
          i = s.indexOf(CB_ID, i + 1);
        }
        done += n;
        onProgress?.(Math.min(1, done / total), a);
      }
    }
    if (tried.length){
      const t = tried[0];
      throw new Error(`找到 ${tried.length} 处 "SEGGER RTT"，但结构都不可信（第一个 0x${t.addr.toString(16)}：${t.reason}）`);
    }
    return 0;
  }

  /** 校验某个地址是不是合理的控制块（结构自洽才认） */
  static async validate(mem, addr){
    try {
      const hdr = await mem.readMem(addr, 24);
      if (latin1(hdr.subarray(0, 10)) !== CB_ID) return { ok: false, reason: `没有 "SEGGER RTT" 标识` };
      const maxUp = u32le(hdr, 16), maxDown = u32le(hdr, 20);
      if (maxUp < 1 || maxUp > 16 || maxDown > 16) return { ok: false, reason: `通道数不合理（up=${maxUp} down=${maxDown}）` };
      const upBase = addr + 24, downBase = upBase + ENTRY * maxUp;
      let used = 0, bytes = 0;
      for (let i = 0; i < maxUp + maxDown; i++){
        const base = i < maxUp ? upBase : downBase;
        const idx = i < maxUp ? i : i - maxUp;
        const b = await mem.readMem(base + ENTRY * idx, ENTRY);
        const size = u32le(b, 8), wr = u32le(b, 12), rd = u32le(b, 16), pbuf = u32le(b, 4);
        if (!size) continue;                                   // 没用到的通道
        used++;
        if (size > (1 << 20)) return { ok: false, reason: `通道 ${i} 缓冲大小 ${size} 不合理` };
        if (wr >= size || rd >= size) return { ok: false, reason: `通道 ${i} 读写指针越界（wr=${wr} rd=${rd} size=${size}）` };
        if (!pbuf || (pbuf & 3)) return { ok: false, reason: `通道 ${i} 缓冲指针无效（0x${pbuf.toString(16)}）` };
        bytes += size;
      }
      if (!used) return { ok: false, reason: '所有通道都没配置缓冲' };
      if (!bytes) return { ok: false, reason: '缓冲总大小为 0' };
      return { ok: true, reason: '', maxUp, maxDown, used, bytes };
    } catch (e){
      return { ok: false, reason: '读取失败：' + (e?.message || e) };
    }
  }

  async init(addr = this.addr){
    const hdr = await this.mem.readMem(addr, 24);
    if (latin1(hdr.subarray(0, 10)) !== CB_ID){
      throw new Error(`0x${addr.toString(16)} 处不是 RTT 控制块（读到 "${latin1(hdr.subarray(0, 16))}"）`);
    }
    this.addr = addr;
    this.maxUp = u32le(hdr, 16);
    this.maxDown = u32le(hdr, 20);
    if (this.maxUp > 16 || this.maxDown > 16) throw new Error(`控制块里的通道数不合理（up=${this.maxUp} down=${this.maxDown}）`);
    this.upBase = addr + 24;
    this.downBase = this.upBase + ENTRY * this.maxUp;
    this.up = []; this.down = [];
    for (let i = 0; i < this.maxUp; i++) this.up.push(await this._entry(this.upBase, i));
    for (let i = 0; i < this.maxDown; i++) this.down.push(await this._entry(this.downBase, i));
    this._lastWr.clear(); this._lost.clear();
    return this;
  }

  /**
   * 读一个通道表项（24 字节）。
   *
   * 🚨 读**一次不通过结构校验就重读一次**：探针的 AP 读是挂起读，紧跟写/换地址之后
   *    偶尔会拿到上一笔事务的残渣（实测读到过 size=560229490、pbuf=0xd 这种）。
   *    这类垃圾几乎都过不了下面的合理性校验，所以"按需重读"比"无脑读两遍"划算得多
   *    （后者把 RTT 吞吐砍掉一半，实测 330 → 154 KB/s）。
   */
  async _entry(base, i){
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++){
      try { return await this._entryOnce(base, i); }
      catch (e){ lastErr = e; }
    }
    throw lastErr;
  }

  async _entryOnce(base, i){
    const b = await this.mem.readMem(base + ENTRY * i, ENTRY);
    const e = { sName: u32le(b, 0), pbuf: u32le(b, 4), size: u32le(b, 8), wr: u32le(b, 12), rd: u32le(b, 16), flags: u32le(b, 20) };
    // 合理性检查：目标刚复位/没在跑时，控制块位置可能只剩旧数据或 0，
    // 不检查的话会拿垃圾指针去读（甚至读到天文数字长度 → RangeError）。
    if (e.size > (1 << 20)) throw new Error(`RTT 通道 ${i} 的缓冲大小不合理（${e.size}）→ 目标可能刚复位或没在运行`);
    if (e.size && (e.wr >= e.size || e.rd >= e.size)) throw new Error(`RTT 通道 ${i} 的读写指针越界（wr=${e.wr} rd=${e.rd} size=${e.size}）→ 控制块内容不可信`);
    if (e.size && !e.pbuf) throw new Error(`RTT 通道 ${i} 的缓冲指针是 0 → 控制块内容不可信`);
    return e;
  }

  /** 通道名（存在目标内存里，按需读一次） */
  async name(dir, ch){
    const e = (dir === 'up' ? this.up : this.down)[ch];
    if (!e || !e.sName) return '';
    const k = `${dir}${ch}`;
    if (!this._names.has(k)){
      let nm = '';
      try { nm = latin1((await this.mem.readMem(e.sName, 16)).subarray(0, 16)).replace(/\0.*$/, ''); } catch {}
      this._names.set(k, nm);
    }
    return this._names.get(k);
  }

  // ---------------- 上行（目标 → 主机） ----------------
  /**
   * @returns {Promise<{bytes:Uint8Array, lost:number, full:boolean, high:boolean,
   *                    level:number, wr:number, rd:number}>}
   *   level = 本次读到的字节占缓冲容量（size-1）的比例；high = 水位 ≥ 3/4。
   */
  async readUp(ch = 0){
    const e = await this._entry(this.upBase, ch);            // 每次整项重读：WrOff/RdOff 一致，且能跟上固件重新初始化缓冲
    this.up[ch] = e;
    const empty = { bytes: new Uint8Array(0), lost: 0, full: false, high: false, level: 0, wr: e.wr, rd: e.rd };
    if (!e.size) return empty;
    let n = e.wr - e.rd;
    if (n < 0) n += e.size;
    if (n === 0) return empty;

    let data;
    /**
     * 读一段上行数据：**绕回时必须分两段读**（缓冲末端 + 开头）。
     * 抽成函数是因为下面的"错位读重试"也得走同一条路 —— 老代码重试只读了
     * `readMem(pbuf + rd, n)` 单段，绕回时那会跨过缓冲末端去读相邻内存：
     * 只要重试回来的内容里恰好没有 "SEGGER RTT" 签名，就被当成正常数据用掉并推进 RdOff，
     * 于是**未绕回的错误数据静默进了日志**（代码审查抓到的）。
     */
    const readSpan = async () => {
      if (e.rd + n <= e.size) return await this.mem.readMem(e.pbuf + e.rd, n);
      const n1 = e.size - e.rd;
      const a = await this.mem.readMem(e.pbuf + e.rd, n1);
      const b = await this.mem.readMem(e.pbuf, n - n1);
      const out = new Uint8Array(a.length + b.length);
      out.set(a); out.set(b, a.length);
      return out;
    };
    data = await readSpan();

    // 错位读防护：高速下 SWD 偶发把别的地址内容读回来，最明显的指纹是数据里混进了
    // 控制块签名 "SEGGER RTT"（真实日志里极少出现这个字符串）。整段丢弃、**不推进 RdOff**
    // —— 下一轮会原样重读，数据不丢；若时钟太高持续出错，表现为 corrupt 一直涨，提示降时钟。
    if (Rtt._looksCorrupt(data)){
      const retry = await readSpan();                          // 先立即重读一次（同样两段逻辑）
      if (Rtt._looksCorrupt(retry)){
        return { ...empty, corrupt: true };
      }
      data = retry;
    }

    await this.mem.writeMem(this.upBase + ENTRY * ch + 16, u32leBytes(e.wr));  // RdOff = WrOff

    // 过载信号：水位（环形缓冲最多装 size-1）
    const cap = e.size - 1;
    const level = cap > 0 ? n / cap : 0;
    const full = n >= cap;
    const high = level >= 0.75;
    if (full) this._full.set(ch, (this._full.get(ch) || 0) + 1);
    if (high) this._high.set(ch, (this._high.get(ch) || 0) + 1);
    if (level > this.peak) this.peak = level;

    // 精确差值：只有在主机侧 RdOff 落后时才算得出来（见文件头 ③）
    const prev = this._lastWr.get(ch);
    let lost = 0;
    if (prev !== undefined){
      const advanced = (e.wr - prev + e.size) % e.size;
      lost = Math.max(0, advanced - data.length);
      if (lost) this._lost.set(ch, (this._lost.get(ch) || 0) + lost);
    }
    this._lastWr.set(ch, e.wr);
    return { bytes: data, lost, full, high, level, wr: e.wr, rd: e.rd };
  }

  /** 错位读指纹：数据里混进了控制块签名（重读一次能救回来就救，救不回就整轮丢弃重读） */
  static _looksCorrupt(data){
    return latin1(data).includes(CB_ID);
  }

  totalLost(ch){ return this._lost.get(ch) || 0; }
  fullCount(ch){ return this._full.get(ch) || 0; }
  highCount(ch){ return this._high.get(ch) || 0; }

  // ---------------- 下行（主机 → 目标） ----------------
  /** 写多少算多少（目标不来取就只能写满缓冲）；返回实际写入字节数 */
  async writeDown(ch, bytes){
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!data.length) return 0;
    const e = await this._entry(this.downBase, ch);
    this.down[ch] = e;
    if (!e.size) return 0;
    const free = (e.size - 1 + e.rd - e.wr + e.size) % e.size;
    const n = Math.min(data.length, free);
    if (n <= 0) return 0;
    const part = Math.min(n, e.size - e.wr);
    if (part === n){
      await this.mem.writeMem(e.pbuf + e.wr, data.subarray(0, n));
    } else {
      await this.mem.writeMem(e.pbuf + e.wr, data.subarray(0, part));
      await this.mem.writeMem(e.pbuf, data.subarray(part, n));
    }
    await this.mem.writeMem(this.downBase + ENTRY * ch + 12, u32leBytes((e.wr + n) % e.size));
    return n;
  }

  info(){
    return {
      addr: this.addr, maxUp: this.maxUp, maxDown: this.maxDown,
      up: this.up.map((e, i) => ({ ch: i, size: e.size, pbuf: e.pbuf, wr: e.wr, rd: e.rd, flags: e.flags })),
      down: this.down.map((e, i) => ({ ch: i, size: e.size, pbuf: e.pbuf, wr: e.wr, rd: e.rd, flags: e.flags })),
    };
  }
}
