/**
 * 波形渲染（canvas 2D，零依赖）。
 *
 * 三条性能/正确性上的硬规矩：
 *  1. **每像素列只画 min/max 两条极值**（不是平均、更不是逐样本）—— 平均会把尖峰抹平，
 *     而尖峰恰恰是要看的东西。抽包络的活儿在 `store.Channel.columns()` 里（带 LOD 金字塔）。
 *  2. 复用缓冲：每帧不 new 数组（包络缓冲按「画布宽度 × 通道数」分配一次）。
 *     🚨 **每个通道一份**：早期版本所有通道共用一份 `_mn/_mx`，于是后算的通道把先算的覆盖掉 ——
 *     画出来是 8 条完全重合的曲线（自测截图时一眼看出来的，代码"看着很合理"）。
 *  3. 高清屏用 `devicePixelRatio` 放大 backing store，线宽按 dpr 缩放（否则 1px 线糊成 2px 灰线）。
 *
 * 视图 = 样本索引区间 [start, end)。X 轴刻度用 `store.timeAt()` 换算成真实时间（µs），
 * 所以"时间"是目标侧的时间戳，不是浏览器的时间。
 */
const PALETTE = ['#4ea1ff', '#ffb020', '#38d39f', '#ff6b6b', '#c792ea', '#ffd166', '#7bdff2', '#f78fb3'];

export class ScopeRenderer {
  constructor(canvas, opts = {}){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.palette = opts.palette || PALETTE;
    this.store = null;
    this.view = { start: 0, end: 1 };
    this.cursor = null;            // 样本索引
    this.cursorLabel = null;       // 游标处的时刻文本（页脚/图例/自测共用）
    this.trigger = null;           // {index, pre, post}
    this.mode = opts.mode || 'auto';  // （叠加模式下）auto = 每通道自适应量程；shared = 共用
    this.layout = opts.layout || 'overlay';   // overlay = 叠加；lanes = 分道（每通道一条泳道、各自量程）
    this.showGrid = true;
    this.hidden = new Set();       // 隐藏的通道序号
    this._cols = 0;
    this._buf = [];                // 每通道一份 {min,max} 包络缓冲
    this._ranges = [];             // 每通道在可见窗口里的 [min,max]（防抖用）
    this.padding = { l: 52, r: 12, t: 10, b: 22 };
  }

  setStore(store){ this.store = store; this.fitAll(); }
  setVisible(i, on){ if (on) this.hidden.delete(i); else this.hidden.add(i); }
  isVisible(i){ return !this.hidden.has(i); }
  visibleCount(){ let n = 0; for (let i = 0; i < (this.store?.channels.length || 0); i++) if (this.isVisible(i)) n++; return n; }
  setTrigger(t){ this.trigger = t; }

  /** 全览 */
  fitAll(){
    const n = this.store?.count || 0;
    this.view = { start: 0, end: Math.max(1, n) };
  }

  get span(){ return Math.max(1, this.view.end - this.view.start); }

  /** 把视图限制在数据范围内（并保证至少 2 个样本宽） */
  clampView(){
    const n = Math.max(2, this.store?.count || 2);
    let { start, end } = this.view;
    let w = Math.max(2, Math.min(n, end - start));
    if (start < 0) start = 0;
    if (start + w > n) start = n - w;
    if (start < 0) start = 0;
    this.view = { start, end: start + w };
  }

  /** 缩放：anchorFrac ∈ [0,1] 是鼠标在绘图区里的横向位置（0=左边缘） */
  zoomBy(factor, anchorFrac = 0.5){
    const n = Math.max(2, this.store?.count || 2);
    const anchor = this.view.start + this.span * anchorFrac;
    let w = this.span / factor;
    w = Math.max(2, Math.min(n, w));
    let start = anchor - w * anchorFrac;
    this.view = { start, end: start + w };
    this.clampView();
  }

  panBy(frac){
    const d = this.span * frac;
    this.view = { start: this.view.start + d, end: this.view.end + d };
    this.clampView();
  }

  zoomTo(a, b){
    if (b - a < 2) b = a + 2;
    this.view = { start: a, end: b };
    this.clampView();
  }

  // ---- 坐标换算（内部用 CSS 像素）----
  get plotW(){ return Math.max(1, this.canvas.clientWidth - this.padding.l - this.padding.r); }
  get plotH(){ return Math.max(1, this.canvas.clientHeight - this.padding.t - this.padding.b); }
  xOf(i){ return this.padding.l + (i - this.view.start) / this.span * this.plotW; }
  sampleAt(x){ return this.view.start + (x - this.padding.l) / this.plotW * this.span; }

  /**
   * 游标处的时刻：**相对采集起点**（µs）。
   * 为什么不显示"样本序号"或"相对窗口左边缘"？——序号看不出时间，而相对窗口的时间会随缩放平移变化，
   * 同一个位置两次读数不一样，没法对着 CSV 的 `t_us` 核。相对采集起点才是"这一刻到底发生了什么"。
   */
  cursorTime(){
    const st = this.store;
    if (!st || !st.count || this.cursor == null) return null;
    const i = Math.min(st.count - 1, Math.max(0, Math.round(this.cursor)));
    const relUs = st.timeAt(i) - st.timeAt(0);
    return { index: i, relUs, text: fmtTime(relUs) };
  }

  /** 主绘制。返回本次是否用了 LOD（排障/自测用） */
  draw(){
    const c = this.canvas, ctx = this.ctx;
    const dpr = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;
    const W = c.clientWidth || 300, H = c.clientHeight || 150;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)){
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#11151c';
    ctx.fillRect(0, 0, W, H);

    const st = this.store;
    const { l, t, b } = this.padding;
    const pw = this.plotW, ph = this.plotH;
    if (!st || !st.count){ this._text(ctx, '还没有数据 —— 连上探针并「开始采样」', l + 8, t + 20, '#7b8794'); return false; }

    const cols = Math.max(2, Math.floor(pw));
    if (!this._cols || this._cols < cols){
      this._cols = cols;
      this._buf = [];                       // 每通道**各自**的包络缓冲（共用一份会把前面通道覆盖掉）
    }

    // 触发窗口底色（先画，压在波形下面）
    if (this.trigger && this.trigger.index >= 0){
      const x = this.xOf(this.trigger.index);
      ctx.fillStyle = 'rgba(255,107,107,0.10)';
      ctx.fillRect(l, t, Math.max(0, Math.min(pw, x - l)), ph);
      ctx.strokeStyle = '#ff6b6b'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, t); ctx.lineTo(Math.round(x) + 0.5, t + ph); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 抽包络 + 量程
    const n = this.store.count;
    const a = Math.max(0, Math.floor(this.view.start));
    const z = Math.min(n, Math.ceil(this.view.end));
    let usedLod = false;
    let gMin = Infinity, gMax = -Infinity;
    this._ranges = [];
    for (let k = 0; k < st.channels.length; k++){
      const ch = st.channels[k];
      if (!this.isVisible(k)){ this._ranges.push(null); this._buf[k] = null; continue; }
      if (!this._buf[k]) this._buf[k] = { min: new Float64Array(this._cols), max: new Float64Array(this._cols) };
      const buf = this._buf[k];
      usedLod = ch.columns(a, z, cols, buf.min, buf.max) || usedLod;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < cols; i++){ if (buf.min[i] < mn) mn = buf.min[i]; if (buf.max[i] > mx) mx = buf.max[i]; }
      // 防抖：量程变化小于 2% 就沿用上一次（否则波形会随噪声上下乱跳）
      const prev = this._ranges[k];
      if (prev && Number.isFinite(prev[0])){
        const d = Math.max(1e-12, mx - mn);
        if (Math.abs(prev[0] - mn) < d * 0.02 && Math.abs(prev[1] - mx) < d * 0.02){ mn = prev[0]; mx = prev[1]; }
      }
      this._ranges[k] = [mn, mx];
      if (Number.isFinite(mn)){ gMin = Math.min(gMin, mn); gMax = Math.max(gMax, mx); }
    }
    if (!Number.isFinite(gMin) || !Number.isFinite(gMax)){ gMin = 0; gMax = 1; }
    if (gMax - gMin < 1e-12){ gMax = gMin + 1; }

    const shared = this.mode === 'shared';
    /**
     * 分道（lanes）：每个可见通道占一条横带，**各自独立量程** —— 这是多通道混合单位的正解
     * （叠加模式下每路都自动量程到满高，三个信号叠起来就是一坨，用户实测反馈过）。
     * 带内留 12% 上下留白，免得波形顶到分隔线上；通道被隐藏时泳道自动重排。
     */
    const laneIdx = [];
    for (let k = 0; k < st.channels.length; k++) if (this.isVisible(k)) laneIdx.push(k);
    const nLanes = Math.max(1, laneIdx.length);
    const band = ph / nLanes;
    const laneOf = k => {
      const i = laneIdx.indexOf(k);
      return { top: t + i * band, h: band };
    };
    const yOf = (v, k) => {
      let lo, hi, top = t, height = ph;
      if (this.layout === 'lanes'){
        const L = laneOf(k); top = L.top; height = L.h;
        const r = this._ranges[k] || [gMin, gMax]; lo = r[0]; hi = r[1];
      } else if (shared){ lo = gMin; hi = gMax; }
      else { const r = this._ranges[k] || [gMin, gMax]; lo = r[0]; hi = r[1]; }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-12){ lo = 0; hi = 1; }
      const inset = this.layout === 'lanes' ? height * 0.12 : 0;
      const uh = height - inset * 2;
      return top + inset + uh - (v - lo) / (hi - lo) * uh;
    };

    if (this.showGrid) this._grid(ctx, W, H, shared ? [gMin, gMax] : null);

    // 波形
    // 🚨 高清屏（dpr≠1）必须把线宽和坐标都换算到**设备像素**再对齐：
    //    否则 1 CSS px 的线落在 1.2 个设备像素上 → 抗锯齿把颜色摊成两层 → 波形发灰发淡
    //    （自测截图时肉眼发现：8 条线看着像"没画出来"）。
    const px = 1 / dpr;
    ctx.lineWidth = px;
    // 分道模式：先画泳道分隔线 + 每道的名字/当前值（压在波形下面）
    if (this.layout === 'lanes'){
      for (let i = 0; i < laneIdx.length; i++){
        const k = laneIdx[i];
        const top = t + i * band;
        if (i > 0){
          ctx.strokeStyle = '#2a3340'; ctx.lineWidth = px;
          ctx.beginPath(); ctx.moveTo(l, Math.round(top) + px / 2); ctx.lineTo(l + pw, Math.round(top) + px / 2); ctx.stroke();
        }
        // 每道自己的中线（该道量程中点）淡画一条：一眼看出"围绕中点波动"
        const rr = this._ranges[k];
        if (rr && Number.isFinite(rr[0])){
          const yMid = yOf((rr[0] + rr[1]) / 2, k);
          ctx.strokeStyle = '#1c232c';
          ctx.beginPath(); ctx.moveTo(l, yMid); ctx.lineTo(l + pw, yMid); ctx.stroke();
        }
        // 道内左上角：通道名 + 当前值（信息量同图例，但不占画布外的地方）
        const chn = st.channels[k];
        const idx2 = this.cursor != null ? this.cursor : st.count - 1;
        const val2 = idx2 >= 0 && idx2 < st.count ? chn.value(idx2) : NaN;
        this._text(ctx, `${chn.name}  ${fmtVal(val2)}`, l + 6, top + 10, this.palette[k % this.palette.length]);
      }
    }
    const per = (z - a) / cols;                   // 每个像素列覆盖多少个样本
    for (let k = 0; k < st.channels.length; k++){
      const ch = st.channels[k];
      if (!this.isVisible(k) || !this._buf[k]) continue;
      const buf = this._buf[k];
      const color = this.palette[k % this.palette.length];
      ctx.strokeStyle = color;

      /**
       * 🚨 **列与列之间必须连起来**。第一版每列只画一条 min→max 的**竖线**：
       *    信号变化快时相邻列的竖线挨在一起，看着像波形；
       *    可信号慢的时候（每列几十上百个样本）每列就退化成**一个孤立的点** ——
       *    用户看到的就是"一堆连不起来的点"（实测反馈："都没有连成线"）。
       * 现在两种画法按"每列多少样本"切换：
       *   · 每列 < 1.5 个样本 → **折线连点**（放大看原始采样点，就是一条干净的线）；
       *   · 否则 → **上下包络 + 中间填充**（示波器的包络显示，慢信号自然连成一条线，
       *     快信号显示为一条实心带，且**绝不漏尖峰**）。
       */
      if (per < 1.5){
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < cols; i++){
          const v = buf.min[i];
          if (!Number.isFinite(v)){ started = false; continue; }
          const x = l + i + px / 2, y = yOf(v, k);
          if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
        }
        ctx.stroke();
        continue;
      }

      // 上下包络：一条闭合路径（上包络左→右，下包络右→左），填充 + 描边
      let any = false;
      const top = [], bot = [];
      for (let i = 0; i < cols; i++){
        const mn = buf.min[i], mx = buf.max[i];
        if (!Number.isFinite(mn) || !Number.isFinite(mx)) continue;
        top.push(l + i + px / 2, yOf(mx, k));
        bot.push(l + i + px / 2, yOf(mn, k));
        any = true;
      }
      if (!any) continue;
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      for (let i = 2; i < top.length; i += 2) ctx.lineTo(top[i], top[i + 1]);
      for (let i = bot.length - 2; i >= 0; i -= 2) ctx.lineTo(bot[i], bot[i + 1]);
      ctx.closePath();
      ctx.globalAlpha = 0.16;                    // 包络带：淡填充（多通道叠着时也不糊）
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();                              // 上下沿各描一遍（慢信号就是一条线）
    }

    // 游标：竖线 + 各通道取值点 + **轴下时刻标签**（标尺移到哪，时间就显示在哪）
    const ct = this.cursorTime();
    this.cursorLabel = ct ? ct.text : null;
    if (ct){
      const dpr2 = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;
      const x = this.xOf(ct.index);
      ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1 / dpr2;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, t); ctx.lineTo(Math.round(x) + 0.5, t + ph); ctx.stroke();
      for (let k = 0; k < st.channels.length; k++){
        if (!this.isVisible(k)) continue;
        const y = yOf(st.channels[k].value(ct.index), k);
        ctx.fillStyle = this.palette[k % this.palette.length];
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      this._cursorTag(ctx, `t=${ct.text}`, x, t + ph);
    }

    // 边框
    ctx.strokeStyle = '#2a3340'; ctx.lineWidth = px;
    ctx.strokeRect(l + px / 2, t + px / 2, pw - px, ph - px);
    return usedLod;
  }

  _grid(ctx, W, H, sharedRange){
    const { l, t } = this.padding;
    const pw = this.plotW, ph = this.plotH;
    const dpr = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;
    const px = 1 / dpr;
    ctx.strokeStyle = '#1c232c'; ctx.lineWidth = px;
    // 分道模式：横向网格交给泳道分隔线去画（画满宽会横穿泳道，反而更乱）
    const hLines = this.layout === 'lanes' ? 0 : 4;
    for (let i = 1; i < hLines; i++){
      const y = Math.round(t + ph * i / 4) + px / 2;
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + pw, y); ctx.stroke();
    }
    for (let i = 1; i < 4; i++){
      const x = Math.round(l + pw * i / 4) + px / 2;
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + ph); ctx.stroke();
    }
    // X 轴时间刻度（相对**采集起点**，和游标读数/CSV 的 t_us 同一把尺子）
    const st = this.store;
    if (st && st.count){
      const base = st.timeAt(0);
      for (let i = 0; i <= 4; i++){
        const x = l + pw * i / 4;
        // 游标标签会盖住最近的刻度，干脆让位（标签本身就带时间，不会丢信息）
        if (this.cursor != null && Math.abs(x - this.xOf(this.cursor)) < 34) continue;
        const idx = Math.min(st.count - 1, Math.max(0, Math.round(this.view.start + this.span * i / 4)));
        this._text(ctx, fmtTime(st.timeAt(idx) - base), x + 3, t + ph + 14, '#7b8794', i === 4 ? 'right' : 'left');
      }
    }
    if (sharedRange){
      for (let i = 0; i <= 4; i++){
        const y = t + ph * i / 4;
        const v = sharedRange[1] - (sharedRange[1] - sharedRange[0]) * i / 4;
        this._text(ctx, fmtVal(v), l - 6, y + 3, '#7b8794', 'right');
      }
    }
    void W; void H;
  }

  /** 轴槽里的圆角时刻标签（跟随游标，靠边时自动收回画布内）*/
  _cursorTag(ctx, text, x, axisY){
    const dpr = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;
    const W = this.canvas.clientWidth || 300;
    ctx.font = '11px ui-monospace, Consolas, monospace';
    const w = ctx.measureText(text).width + 10;
    const h = 15;
    const cx = Math.min(W - 2 - w / 2, Math.max(2 + w / 2, x));
    const top = axisY + 4;
    ctx.fillStyle = '#1b2430'; ctx.strokeStyle = '#3d4c60'; ctx.lineWidth = 1 / dpr;
    if (typeof ctx.roundRect === 'function'){
      ctx.beginPath(); ctx.roundRect(cx - w / 2, top, w, h, 3); ctx.fill(); ctx.stroke();
    } else {
      ctx.fillRect(cx - w / 2, top, w, h); ctx.strokeRect(cx - w / 2, top, w, h);
    }
    ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, top + h / 2);
  }

  _text(ctx, s, x, y, color, align = 'left'){
    ctx.fillStyle = color; ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }
}

/** 相对时间格式化：µs → 人看的（<1 ms 用 µs，<1 s 用 ms，再大用 s）*/
export function fmtTime(us){
  const a = Math.abs(us);
  if (a < 1000) return `${us.toFixed(0)} µs`;
  if (a < 1e6) return `${(us / 1000).toFixed(2)} ms`;
  return `${(us / 1e6).toFixed(3)} s`;
}

/** 数值格式化：大数不写满屏零 */
export function fmtVal(v){
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return '—';
  if (a === 0) return '0';
  if (a >= 1e7 || a < 1e-4) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  if (a >= 1000) return v.toFixed(1);
  return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** 图例数据：每通道的当前值/游标值（页面把它渲染成 HTML）*/
export function legendRows(store, cursor, hidden = new Set()){
  if (!store) return [];
  const rows = [];
  for (let k = 0; k < store.channels.length; k++){
    const ch = store.channels[k];
    const idx = cursor != null ? cursor : store.count - 1;
    rows.push({
      index: k, name: ch.name, scalar: ch.scalar,
      color: PALETTE[k % PALETTE.length],
      value: idx >= 0 && idx < store.count ? ch.value(idx) : NaN,
      min: ch.min, max: ch.max,
      visible: !hidden.has(k),
    });
  }
  return rows;
}
