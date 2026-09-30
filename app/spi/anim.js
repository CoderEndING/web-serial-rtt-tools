/**
 * 「动画 / 视频」播放器：把一段视频（或 GIF）**解码 → 逐帧发给屏**。
 *
 * 口径（用户 2026-09-30 拍板："先不做局部刷新"，先用最简洁的那条路）：
 *   · **每帧整屏刷**：`CASET/RASET` +〔档 1 的 RAMWR 命令帧〕+ 像素片 ×N —— 与「刷这一张」完全同一条路，
 *     所以线上字节、错误统计、面板档语义全都现成；
 *   · **发送当节拍器**：解码比发送快就**丢帧**（只保留最新一帧），绝不把队列堆起来 ——
 *     按 30 fps 无条件灌会在 USB 队列里积压，延迟越滚越大，最后看起来像"卡住"；
 *   · 视频走 `<video>` + `requestVideoFrameCallback`（浏览器原生解码，零依赖）；
 *     GIF 走 `ImageDecoder`（Chrome 支持就直接用，逐帧解码、不需要队列）。
 *
 * 为什么不用 WebCodecs / ffmpeg.wasm：本页每帧要发 142 KB（AXS15352）、链路实测 ~3.2 MB/s ⇒
 * 一帧 ~43 ms；而解码 + 缩放 + RGB565 打包只有 1~3 ms（**不到 5%**）。瓶颈在 SPI/USB，
 * 换解码器一分钱都省不下来，还要背 mp4box 之类的依赖（ffmpeg.wasm 更是要 COOP/COEP 响应头，
 * GitHub Pages 给不了）。
 *
 * 想再快只有一个大招：**局部开窗**（只发与上一帧不同的包围盒）—— 按面积比提升帧率，
 * 这一版有意没做（用户：先不做），所以整帧刷。
 */
import * as P from './protocol.js';
import * as I from './image.js';

/** 解码缓冲：够抹平抖动，又不积延迟（4 帧 ≈ 170 ms @24fps）*/
export const MAX_QUEUE = 4;
/** 让出主线程的间隔（每多少帧一次）——刷屏期间别把 UI 冻住 */
const YIELD_EVERY = 4;

/**
 * 源画布 → 目标窗口的映射（canvas 的 drawImage 九参数版）。
 * 与 `image.js` 的 `composeImage()` **同语义**（stretch / fill=铺满裁剪 / fit=适应留边 / none=原始居中），
 * 区别只有一个：这里交给 canvas 做缩放（GPU、带平滑），不再逐像素最近邻
 * —— 视频缩小时最近邻会有明显的锯齿，而"逐字节对账"只对静图那条路有意义。
 */
export function fitRects(sw, sh, dw, dh, mode = 'fill'){
  if (mode === 'stretch') return { sx: 0, sy: 0, sw, sh, dx: 0, dy: 0, dw, dh };
  if (mode === 'none'){
    const tw = Math.min(sw, dw), th = Math.min(sh, dh);
    return { sx: (sw - tw) / 2, sy: (sh - th) / 2, sw: tw, sh: th, dx: (dw - tw) / 2, dy: (dh - th) / 2, dw: tw, dh: th };
  }
  const k = mode === 'fit' ? Math.min(dw / sw, dh / sh) : Math.max(dw / sw, dh / sh);
  const tw = Math.max(1, Math.round(sw * k)), th = Math.max(1, Math.round(sh * k));
  if (mode === 'fit') return { sx: 0, sy: 0, sw, sh, dx: Math.round((dw - tw) / 2), dy: Math.round((dh - th) / 2), dw: tw, dh: th };
  const cw = Math.max(1, Math.round(dw / k)), ch = Math.max(1, Math.round(dh / k));   // 铺满：裁源
  return { sx: Math.round((sw - cw) / 2), sy: Math.round((sh - ch) / 2), sw: cw, sh: ch, dx: 0, dy: 0, dw, dh };
}

/**
 * 一帧像素 → 帧序列（开窗 + 〔RAMWR〕+ 像素片）。
 *
 * `cache` 里缓存"每帧都一样"的那几条（开窗 2 帧 + 档 1 的 RAMWR 命令帧）：同一个窗口刷 N 帧时，
 * 它们逐字节相同，没必要每帧重建（每帧省 3 个对象与 3 次分配，20 fps 下也是白拿）。
 * @param {Uint8Array} px RGB565 字节流（窗口尺寸）
 * @param {{geometry:object, profile:number, lines:number, sliceBytes?:number, cache?:object}} o
 */
export function frameItems(px, o){
  const g = o.geometry;
  const profile = o.profile | 0;
  const lines = o.lines ?? g.lines;
  const cache = o.cache || (o.cache = {});
  if (!cache.head){
    const win = o.window || I.alignWindow(o.x ?? 0, o.y ?? 0, g.w, g.h, { align: g.align, scrW: g.w, scrH: g.h });
    cache.head = [
      ...I.windowItems(win, g),
      ...(profile === 1 ? [I.ramwrCommandItem({ ramWr: g.ramWr, lines })] : []),
    ];
    cache.window = win;
  }
  return [
    ...cache.head,
    ...I.pixelItems(px, {
      profile, qspiColorOpcode: g.colorOpcode, qspiAddrBytes: 3, ramWr: g.ramWr, lines,
      sliceBytes: o.sliceBytes ?? I.PIXEL_SLICE,
    }),
  ];
}

export class PanelAnim {
  /**
   * @param {object} o
   * @param {object} o.session          SpiSession（推流走它；必须 dataReady + enabled）
   * @param {()=>object} o.geometry     当前屏几何（`panel-view.geometry()`）
   * @param {()=>number} o.profile      当前面板档
   * @param {()=>({swap:boolean,littleEndian:boolean,level:number,fit:string})} o.pixelOpts
   * @param {(kind:string,text:string)=>void} [o.log]
   * @param {(px:Uint8Array,win:object)=>void} [o.onFrame]  每帧（预览用）
   * @param {(st:object)=>void} [o.onState]                 状态/统计变化
   */
  constructor(o = {}){
    this.session = o.session;
    this.geometry = o.geometry || (() => I.PANEL_GEOMETRY.st77916);
    this.profile = o.profile || (() => 0);
    this.pixelOpts = o.pixelOpts || (() => ({ swap: false, littleEndian: false, level: 255, fit: 'fill' }));
    this.log = o.log || (() => {});
    this.onFrame = o.onFrame || null;
    this.onState = o.onState || null;
    this.video = o.video || null;          // 页面里那个 <video>（rVFC 需要它真的在渲染）
    this.src = null;                       // { kind:'video'|'gif', name, w, h, frames? }
    this.stat = { frames: 0, bytes: 0, dropped: 0, t0: 0, ms: 0, fps: 0, kbs: 0, lastMs: 0 };
    this._stop = false;
    this._running = false;
    this._q = [];                          // 已解码待发的帧（RGB565）
    this._waiters = [];
    this._rvfc = null;
    this._cap = null;
    this._ctx = null;
    this._cache = null;
  }

  get running(){ return this._running; }

  _emit(){
    const s = this.stat;
    const sec = s.ms / 1000;
    this.onState?.({ running: this._running, frames: s.frames, dropped: s.dropped, bytes: s.bytes,
                     ms: s.ms, fps: sec > 0 ? s.frames / sec : 0, kbs: sec > 0 ? s.bytes / 1024 / sec : 0,
                     lastMs: s.lastMs, src: this.src });
  }

  /** 选文件后建源。video 与 gif 各一条路（都返回 {kind,w,h}）*/
  async load(file){
    this.release();
    const name = file.name || '（片段）';
    if (/^image\/(gif|webp|png)/i.test(file.type) || /\.(gif|webp|png|apng)$/i.test(name)){
      if (typeof ImageDecoder === 'undefined') throw new Error('这个浏览器没有 ImageDecoder（GIF 播放需要 Chrome/Edge 94+）——换成 MP4/WebM 也行');
      const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type || 'image/gif' });
      await dec.completed;
      /**
       * 🚨 `completed` 只保证"数据收齐了"，**不等于轨道信息就绪**：这时
       * `tracks.selectedTrack` 很可能还是 null / `frameCount` 还是 0。实测（Chrome 153）：
       * 不 await `tracks.ready` 的话，一个 60 帧的 GIF 会被记成 **0 帧**，
       * 于是「循环」没勾时 `_runGif` 里 `i >= 0` 立刻成立 → **只播一帧就收工**。
       */
      if (dec.tracks?.ready) await dec.tracks.ready;
      const track = dec.tracks.selectedTrack || dec.tracks?.[0] || null;
      const first = await dec.decode({ frameIndex: 0 });
      const w = first.image.displayWidth, h = first.image.displayHeight;
      first.image.close();
      this.src = { kind: 'gif', name, w, h, frames: track?.frameCount ?? 0, dec };
      this.log('i', `动画源：${name}（逐帧图像 GIF/APNG/WebP · ${w}×${h} · ${this.src.frames} 帧）`);
    } else if (this.video){
      const v = this.video;
      const url = URL.createObjectURL(file);
      this._url = url;
      await new Promise((res, rej) => {
        const ok = () => { cleanup(); res(); };
        const bad = () => { cleanup(); rej(new Error('这个视频浏览器解不了（换 MP4/H.264 或 WebM 试试）')); };
        const cleanup = () => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad); };
        v.addEventListener('loadedmetadata', ok);
        v.addEventListener('error', bad);
        v.src = url;
        v.load();
        setTimeout(() => { cleanup(); v.videoWidth ? res() : rej(new Error('读视频元数据超时')); }, 8000);
      });
      this.src = { kind: 'video', name, w: v.videoWidth, h: v.videoHeight, duration: v.duration };
      this.log('i', `动画源：${name}（视频 · ${v.videoWidth}×${v.videoHeight} · ${v.duration.toFixed(1)} s）`);
    } else {
      throw new Error('页面里没有 <video> 元素（视频通路需要它）');
    }
    this._prep();
    this._emit();
    return this.src;
  }

  /** 建/复用捕获画布（尺寸 = 开窗后的窗口，和静图那条路一致）*/
  _prep(){
    const g = this.geometry();
    const po = this.pixelOpts();
    const win = I.alignWindow(0, 0, g.w, g.h, { align: g.align, scrW: g.w, scrH: g.h });
    this.win = win;
    this._cache = null;                        // 几何/档位可能变了，帧头缓存作废
    if (!this._cap){
      this._cap = document.createElement('canvas');
      this._ctx = this._cap.getContext('2d', { willReadFrequently: true });
    }
    if (this._cap.width !== win.w || this._cap.height !== win.h){ this._cap.width = win.w; this._cap.height = win.h; }
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'medium';
    this._opts = { geometry: g, profile: this.profile(), lines: g.lines, window: win, x: 0, y: 0, fit: po.fit, cache: this._cache };
  }

  /** 抓当前一帧 → RGB565（video 的 rVFC 回调里调；GIF 在推流循环里调）*/
  _grab(source){
    const g = this.geometry(), po = this.pixelOpts();
    const sw = source.videoWidth ?? source.displayWidth ?? this.src.w;
    const sh = source.videoHeight ?? source.displayHeight ?? this.src.h;
    const r = fitRects(sw, sh, this.win.w, this.win.h, po.fit);
    const ctx = this._ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.win.w, this.win.h);
    ctx.drawImage(source, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
    const img = ctx.getImageData(0, 0, this.win.w, this.win.h);
    return I.rgbaTo565(img.data, { swap: po.swap, littleEndian: po.littleEndian, level: po.level });
  }

  _pushFrame(px){
    if (this._q.length >= MAX_QUEUE){ this.stat.dropped++; return; }   // 队列满 = 丢这一帧（发送才是节拍器）
    this._q.push(px);
    const w = this._waiters.shift();
    if (w) w();
  }

  _nextFrame(timeoutMs = 250){
    if (this._q.length) return Promise.resolve(true);
    return new Promise(res => {
      let done = false;
      const fin = () => { if (!done){ done = true; res(this._q.length > 0); } };
      this._waiters.push(fin);
      setTimeout(fin, timeoutMs);
    });
  }

  /**
   * 开始推流。resolve 时 = 播完（或用户停了）。
   * 视频：播放 → rVFC 抓帧入队（队列满就丢）→ 循环取帧发送；
   * GIF：逐帧解码（发送完一帧再解下一帧，天然不积压）。
   */
  async start(){
    if (!this.src) throw new Error('先选一个视频 / GIF');
    const s = this.session;
    if (!s.dataReady) throw new Error('先「连接数据端点」（或勾「用假探针」）');
    if (!s.enabled) this.log('w', '桥还没使能 —— 未使能时 bulk OUT 端点不武装，写会一直 NAK/超时');
    if (s.busy) throw new Error('桥上正忙（另一次刷屏/重放没结束）');
    if (this._running) return;
    this._prep();
    this._stop = false;
    this._running = true;
    this.stat = { frames: 0, bytes: 0, dropped: 0, t0: performance.now(), ms: 0, fps: 0, kbs: 0, lastMs: 0 };
    this._emit();
    const g = this.geometry();
    const prof = this.profile();
    this.log('i', `动画开始：${this.src.name} · 窗口 ${this.win.w}×${this.win.h} · 档 ${prof} · ` +
      `每帧 ${this.win.w * this.win.h * 2} 字节（整帧刷，未做局部开窗）`);
    s.setBusy(true);
    try {
      if (this.src.kind === 'video') await this._runVideo();
      else await this._runGif();
    } finally {
      this._running = false;
      s.setBusy(false);
      const st = this.stat;
      st.ms = performance.now() - st.t0;
      st.fps = st.ms > 0 ? st.frames / (st.ms / 1000) : 0;
      st.kbs = st.ms > 0 ? st.bytes / 1024 / (st.ms / 1000) : 0;
      this._q = [];
      this._emit();
      this.log(st.frames ? 'g' : 'w', `动画结束：${st.frames} 帧 · ${(st.bytes / 1024).toFixed(0)} KB · ` +
        `${(st.ms / 1000).toFixed(1)} s · 实测 ${st.fps.toFixed(1)} fps · ${st.kbs.toFixed(0)} KB/s` +
        (st.dropped ? ` · 丢帧 ${st.dropped}（发送跟不上解码，正常）` : ''), st.frames ? 'g' : 'w');
    }
  }

  stop(){
    this._stop = true;
    try { this.video?.pause(); } catch {}
  }

  async _runVideo(){
    const v = this.video;
    v.loop = !!this.loop;
    v.currentTime = 0;
    v.muted = true;
    const onFrame = (now, meta) => {
      if (this._stop) return;
      this._rvfc = v.requestVideoFrameCallback(onFrame);
      if (this._q.length >= MAX_QUEUE){ this.stat.dropped++; return; }   // 满了就别抓了（抓了也是白费）
      this._pushFrame(this._grab(v));
      // 背压：队列满 → 暂停播放，让发送追上；快空了 → 接着播
      if (this._q.length >= MAX_QUEUE) v.pause();
      else if (v.paused && !this._stop) v.play().catch(() => {});
    };
    this._rvfc = v.requestVideoFrameCallback(onFrame);
    await v.play();

    while (!this._stop){
      const ok = await this._nextFrame();
      if (this._stop) break;
      if (!ok){
        // 队列空且视频已结束（非循环）：收工
        if (v.ended) break;
        continue;
      }
      await this._sendOne(this._q.shift());
      if (v.paused && this._q.length <= 1 && !this._stop) v.play().catch(() => {});
    }
    if (this._rvfc != null){ try { v.cancelVideoFrameCallback(this._rvfc); } catch {} this._rvfc = null; }
    try { v.pause(); } catch {}
  }

  async _runGif(){
    const dec = this.src.dec;
    const total = dec.tracks?.selectedTrack?.frameCount || this.src.frames || 0;
    let i = 0;
    while (!this._stop){
      let image;
      try {
        ({ image } = await dec.decode({ frameIndex: i }));
      } catch (e){
        // 越界 = 全片播完了（有的源浏览器给不出 frameCount，只能靠这一步兜底）。
        // i === 0 还解不出来 = 这个文件根本没法播，别在这儿空转。
        if (!this.loop || i === 0) break;
        i = 0;
        continue;
      }
      if (this._stop){ image.close(); break; }
      const px = this._grab(image);
      image.close();
      await this._sendOne(px);
      i++;
      if (total && i >= total){
        if (!this.loop) break;
        i = 0;
      }
    }
  }

  /** 发一帧（整帧）：开窗 +〔RAMWR〕+ 像素片；只有末片要应答 —— 与「刷这一张」同一条路 */
  async _sendOne(px){
    const t0 = performance.now();
    const items = frameItems(px, { ...this._opts, cache: this._cache });
    const r = await this.session.sendFrames(items, {
      tag: 'panel', quiet: true, timeoutMs: 8000,
      shouldStop: () => this._stop,
    });
    if (this._stop) return;                       // 用户按了停止：这一帧是半截的，别记账也别报错
    const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
    if (bad) this.log('e', `动画第 ${this.stat.frames + 1} 帧有 ${bad} 个非 OK 应答`, 'panel');
    this.stat.frames++;
    this.stat.bytes += px.length;
    this.stat.lastMs = performance.now() - t0;
    this.stat.ms = performance.now() - this.stat.t0;
    this.onFrame?.(px, this.win);
    if ((this.stat.frames % YIELD_EVERY) === 0) await new Promise(r2 => setTimeout(r2, 0));
    this._emit();
  }

  /** 释放源（换文件/收工时调）*/
  release(){
    this.stop();
    try { if (this._rvfc != null && this.video) this.video.cancelVideoFrameCallback(this._rvfc); } catch {}
    this._rvfc = null;
    try { this.src?.dec?.close?.(); } catch {}
    try { if (this._url){ URL.revokeObjectURL(this._url); this._url = null; } } catch {}
    if (this.video){ try { this.video.removeAttribute('src'); this.video.load(); } catch {} }
    this.src = null;
    this._q = [];
  }
}
