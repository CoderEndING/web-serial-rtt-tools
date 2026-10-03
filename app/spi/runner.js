/**
 * SPI 桥的**定时采集执行器**（对应 `#i2c` 页的 `runner.js`，语义刻意保持一致）。
 *
 * 输入是 `frames-dsl.js` 的解析结果：
 *   · **没有周期**的帧 = 一次性：开跑先按顺序各发一遍；
 *   · **有周期**的帧 = 定时组（同一次 `loop`/`every` 块里的帧同属一组，共用周期与轮数）。
 *     每组是一个独立的定时器，到点就把这一组的帧**一次 `sendFrames` 发出去**，
 *     然后把每帧的读回数据交给它自己的 `as` 表达式解码 → 广播成"实时值"。
 *
 * 三条口径（都是从 I2C 侧实测学来的，别改回去）：
 *   1. **发送才是节拍器，但"只晚不丢"**：到点发帧、再按下一次的目标时刻算等待；某拍拖到超过一个周期时
 *      这一拍**照样跑**（只把"迟了多少"记进 `late` 与日志）。丢拍等于悄悄少一个采样点 —— 比晚一点坏得多。
 *      轮数（`loop … 3`）按**成功采样**算，一次失败的发送不吃掉用户要的那一轮。
 *   2. **≤128 ms 的等待必须走 `pace.waitMs`**：以前这里写的是"周期用定时器没关系、只是变慢"，
 *      是错的 —— 页面切到后台时 `setTimeout` 被钳到 ≥1 s，采样率**悄悄**掉到 1 Hz
 *      （波形严重混叠，而界面看着还在跑；面板上的"实测频率"只说明它慢了，不说明数据还能用）。
 *      更长的等待仍交定时器：那属于 pace.js 说的"等久点没关系"，而且能用 `timers` 立刻取消
 *      （2026-10 代码审查）。
 *   3. **解码偏移是"这一帧自己的读数据"**：SPI 一次 xfer 通常就是一个寄存器/一次转换，
 *      把偏移定义在整组拼起来的大缓冲上会算不清（I2C 那边是"一次逻辑读"，语义不同）。
 */
import { applyAs } from '../core/expr.js';
import { waitMs } from '../core/pace.js';
import * as P from './protocol.js';

export class SpiRunner {
  /**
   * @param {object} session SpiSession（只用它的 sendFrames）
   * @param {{onEvent?:(e:object)=>void}} opts
   */
  constructor(session, { onEvent } = {}){
    this.session = session;
    this.onEvent = onEvent || null;
    this.parsed = null;
    this.running = false;
    this.stopping = false;
    this.timers = new Set();
    this.stat = { ticks: 0, late: 0, errors: 0, sent: 0, failed: 0, t0: 0, lastTick: 0 };
    this._resolveStop = null;
  }

  _emit(e){ try { this.onEvent?.(e); } catch { /* 视图自己出错不该拖垮采集 */ } }

  /** 解析结果里能不能跑（一次性帧也可以，跑一遍就结束）*/
  static runnable(parsed){
    return !!parsed && !parsed.errors?.length && parsed.items.length > 0;
  }

  /**
   * 开跑。
   * @param {object} parsed `parseFrames()` 的结果
   */
  async start(parsed){
    if (this.running) this.stop('重新开始');
    if (!SpiRunner.runnable(parsed)){
      this._emit({ type: 'error', msg: parsed?.errors?.length ? '脚本有语法错，先修好再跑' : '没有可发的帧' });
      return false;
    }
    this.parsed = parsed;
    this.running = true;
    this.stopping = false;
    this.stat = { ticks: 0, late: 0, errors: 0, sent: 0, failed: 0, t0: performance.now(), lastTick: 0 };
    const once = parsed.items.filter(it => !it.period);
    const timed = parsed.items.filter(it => it.period);
    const groups = new Map();
    for (const it of timed){
      const g = it.group ?? 0;
      if (!groups.has(g)) groups.set(g, { group: g, period: it.period, count: it.count || 0, items: [] });
      const grp = groups.get(g);
      // 同一组里的周期取最小（正常解析器保证同块同周期；行尾 every 单独成组）
      grp.period = Math.min(grp.period, it.period);
      grp.items.push(it);
    }
    this._emit({ type: 'start', oneShots: once.length, groups: groups.size, items: parsed.items.length,
                 vars: parsed.stats?.vars || [] });
    // 一次性部分：先跑完再启动定时（"先认片子再采样"的顺序语义）
    if (once.length){
      const r = await this._send(once, null);
      this._emit({ type: 'once', sent: r.sent, failed: r.failed, ms: r.ms });
    }
    if (this.stopping){ this.running = false; return true; }
    if (!groups.size){
      this._emit({ type: 'stop', reason: '只有一次性帧，已跑完' });
      this.running = false;
      return true;
    }
    // 每组一个定时器；用"目标时刻 + 序号"算下一拍，避免漂移累积
    for (const grp of groups.values()) this._startGroup(grp);
    this._emit({ type: 'running', groups: groups.size });
    return true;
  }

  /** 停（幂等）：清定时器、取消在飞请求的等待、广播 stop */
  stop(reason = '用户停止'){
    if (!this.running && !this.timers.size) return;
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.running = false;
    this._emit({ type: 'stop', reason, stat: { ...this.stat } });
  }

  _startGroup(grp){
    const period = Math.max(1, grp.period | 0);
    let t0 = 0;           // 第一拍建立时基（别把"启动延迟"算成迟拍）
    let n = 0;            // 尝试的拍数
    let done = 0;         // **成功采样**的拍数 —— 轮数按它算
    this._activeGroups = this._activeGroups || new Map();
    this._activeGroups.set(grp.group, grp);
    const loop = async () => {
      if (this.stopping || !this.running) return;
      if (!t0) t0 = performance.now();
      n++;
      const target = t0 + (n - 1) * period;
      const late = performance.now() - target;
      /**
       * 周期比"一次发送"还短时，这一拍会**迟**（但照跑）—— 与 `#i2c` 的 runner 同一口径：
       * **只晚不丢**。丢拍等于悄悄少一个采样点，比"晚一点"坏得多；迟了多少如实记在 `stat.late`
       * 与日志里（"发送才是节拍器"的意思是别排队堆积，不是丢数据）。
       */
      if (late > period){
        this.stat.late++;
        this._emit({ type: 'late', group: grp.group, late: Math.round(late) });
      }
      const r = await this._send(grp.items, grp);
      if (r.ok){
        done++;
        this.stat.ticks++;
        this.stat.lastTick = performance.now();
        this._emit({ type: 'tick', group: grp.group, n: done, stat: { ...this.stat } });
      }
      if (this.stopping || !this.running) return;
      // 轮数按**成功采样**算（done）：一次失败的发送不该吃掉用户要的那一轮
      if (grp.count && done >= grp.count){
        this._emit({ type: 'groupDone', group: grp.group, n: done });
        this._activeGroups?.delete(grp.group);
        // 各组可能周期不同、轮数不同：只有**所有**组都跑完了才整体停
        if (!this._activeGroups || this._activeGroups.size === 0) this.stop(`定时组跑完 ${done} 轮`);
        return;
      }
      const nextTarget = t0 + n * period;
      const wait = Math.max(0, nextTarget - performance.now());
      // ≤128 ms 走让路自旋（后台不被钳到 1 s）；更长交给定时器（能立刻取消）
      if (wait <= 128){
        await waitMs(wait);
        if (this.stopping || !this.running) return;
        loop();                      // 不 await：与 setTimeout 那条路同形，别让调用栈长高
        return;
      }
      const t = setTimeout(() => { this.timers.delete(t); loop(); }, wait);
      this.timers.add(t);
    };
    // 立刻打第一拍（不等一个周期）—— 用户点了「开始」就该马上看到数
    // （别用 `setTimeout(...,0)`：后台页里它同样会被钳到 1 s，点一下要等一秒才见数）
    loop();
  }

  /** 发一组帧 → 解码 → 广播；返回 {ok, sent, ms}（`ok` = 这一拍算不算一次成功采样） */
  async _send(items, grp){
    const t0 = performance.now();
    let rsps = [];
    let okSend = true;
    try {
      // 在飞请求：读帧都带 RSP；这里给一个与帧数相称的超时（默认 1.5 s 对慢器件偏紧）
      const r = await this.session.sendFrames(items.map(it => ({ ...it })), {
        quiet: true, tag: 'bus', timeoutMs: 2500, shouldStop: () => this.stopping,
      });
      rsps = r.rsps || [];
      this.stat.sent += r.sent || 0;
      this.stat.failed += r.failed || 0;
      if (r.failed) okSend = false;
    } catch (e){
      this.stat.errors++;
      this._emit({ type: 'error', group: grp?.group ?? null, msg: `发送失败：${e?.message || e}` });
      return { ok: false, sent: 0, ms: performance.now() - t0 };
    }
    const values = [];
    for (let i = 0; i < items.length; i++){
      const it = items[i];
      if (!it.as?.length) continue;
      const rsp = rsps[i];
      if (!rsp || rsp.error || rsp.status !== P.ST.OK){
        this.stat.errors++;
        okSend = false;
        this._emit({ type: 'error', group: grp?.group ?? null,
                     msg: `${it.label || '帧'} 没有有效应答（${rsp?.error?.message || 'status=' + rsp?.status}）` });
        continue;
      }
      const data = rsp.data instanceof Uint8Array ? rsp.data : new Uint8Array(rsp.data || 0);
      try {
        const r = applyAs({ ok: true, fields: it.as, hexOnly: false }, data);
        for (const v of r.values) values.push(v);
        if (r.warn) this._emit({ type: 'warn', group: grp?.group ?? null, msg: r.warn });
      } catch (e){
        this.stat.errors++;
        okSend = false;
        this._emit({ type: 'error', group: grp?.group ?? null, msg: `解码失败：${e?.message || e}` });
      }
    }
    if (values.length) this._emit({ type: 'values', group: grp?.group ?? null, values });
    return { ok: okSend, sent: items.length, ms: performance.now() - t0 };
  }
}

/** 给页面用：解析结果的一句话摘要（帧数 / 一次性 / 定时组 / 变量）*/
export function describeRun(parsed){
  if (!parsed) return '还没解析';
  const s = parsed.stats || {};
  const parts = [`${s.frames ?? 0} 条帧`];
  if (s.oneShots) parts.push(`${s.oneShots} 条一次性`);
  if (s.timed) parts.push(`${s.timed} 条定时（${s.groups ?? 0} 组）`);
  if (s.vars?.length) parts.push(`变量 ${s.vars.length} 个：${s.vars.slice(0, 6).join(' ')}${s.vars.length > 6 ? ' …' : ''}`);
  return parts.join(' · ');
}

export { waitMs };
