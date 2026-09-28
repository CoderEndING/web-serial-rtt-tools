/**
 * 波形渲染（canvas 2D，零依赖）。
 *
 * 三条性能/正确性上的硬规矩：
 *  1. **每像素列只画 min/max 两条极值**（不是平均、更不是逐样本）—— 平均会把尖峰抹平，
 *     而尖峰恰恰是要看的东西。抽包络的活儿在 `store.Channel.columns()` 里（带 LOD 金字塔）。
 *  2. 复用缓冲：每帧不 new 数组（`_mn/_mx` 按画布宽度分配一次）。
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
    this.trigger = null;           // {index, pre, post}
    this.mode = opts.mode || 'auto';  // auto = 每通道自适应量程；shared = 共用
    this.showGrid = true;
    this.hidden = new Set();       // 隐藏的通道序号
    this._mn = new Float64Array(0);
    this._mx = new Float64Array(0);
    this._ranges = [];             // 每通道在可见窗口里的 [min,max]（防抖用）
    this.padding = { l: 52, r: 12, t: 10, b: 22 };
  }

  setStore(store){ this.store = store; this.fitAll(); }
  setVisible(i, on){ if (on) this.hidden.delete(i); else this.hidden.add(i); }
  isVisible(i){ return !this.hidden.has(i); }
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
    if (this._mn.length < cols){ this._mn = new Float64Array(cols); this._mx = new Float64Array(cols); }

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
      if (!this.isVisible(k)){ this._ranges.push(null); continue; }
      usedLod = ch.columns(a, z, cols, this._mn, this._mx) || usedLod;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < cols; i++){ if (this._mn[i] < mn) mn = this._mn[i]; if (this._mx[i] > mx) mx = this._mx[i]; }
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
    const yOf = (v, k) => {
      let lo, hi;
      if (shared){ lo = gMin; hi = gMax; }
      else { const r = this._ranges[k] || [gMin, gMax]; lo = r[0]; hi = r[1]; }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-12){ lo = 0; hi = 1; }
      return t + ph - (v - lo) / (hi - lo) * ph;
    };

    if (this.showGrid) this._grid(ctx, W, H, shared ? [gMin, gMax] : null);

    // 波形
    ctx.lineWidth = 1;
    for (let k = 0; k < st.channels.length; k++){
      const ch = st.channels[k];
      if (!this.isVisible(k)) continue;
      ctx.strokeStyle = this.palette[k % this.palette.length];
      ctx.beginPath();
      for (let i = 0; i < cols; i++){
        const mn = this._mn[i], mx = this._mx[i];
        if (!Number.isFinite(mn) && !Number.isFinite(mx)) continue;
        const x = l + i + 0.5;
        // 每列一条竖线（min→max）：等价于示波器的包络显示
        const y1 = yOf(mn, k), y2 = yOf(mx, k);
        ctx.moveTo(x, y1);
        ctx.lineTo(x, Math.max(y1 + 0.6, y2));
      }
      ctx.stroke();
    }

    // 游标
    if (this.cursor != null && this.cursor >= 0 && this.cursor < n){
      const x = this.xOf(this.cursor);
      ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, t); ctx.lineTo(Math.round(x) + 0.5, t + ph); ctx.stroke();
      for (let k = 0; k < st.channels.length; k++){
        if (!this.isVisible(k)) continue;
        const y = yOf(st.channels[k].value(this.cursor), k);
        ctx.fillStyle = this.palette[k % this.palette.length];
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    // 边框
    ctx.strokeStyle = '#2a3340'; ctx.lineWidth = 1;
    ctx.strokeRect(l + 0.5, t + 0.5, pw - 1, ph - 1);
    return usedLod;
  }

  _grid(ctx, W, H, sharedRange){
    const { l, t } = this.padding;
    const pw = this.plotW, ph = this.plotH;
    ctx.strokeStyle = '#1c232c'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++){
      const y = Math.round(t + ph * i / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + pw, y); ctx.stroke();
    }
    for (let i = 1; i < 6; i++){
      const x = Math.round(l + pw * i / 6) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + ph); ctx.stroke();
    }
    // X 轴时间刻度（0 / 1/4 / 1/2 / 3/4 / 末端 的相对时间）
    const st = this.store;
    if (st && st.count){
      const t0 = st.timeAt(Math.max(0, Math.floor(this.view.start)));
      const t1 = st.timeAt(Math.min(st.count - 1, Math.ceil(this.view.end)));
      const spanUs = t1 - t0;
      for (let i = 0; i <= 4; i++){
        const x = l + pw * i / 4;
        const rel = spanUs * i / 4;
        this._text(ctx, fmtTime(rel), x + 3, t + ph + 14, '#7b8794', i === 4 ? 'right' : 'left');
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
