/**
 * 「J-Scope 波形」页（`#scope`）—— 把变量选择、探针配置、收流、绘图、触发、导出串起来。
 *
 * 页面骨架沿用仓库既有约定：左侧栏放"设置"，工具栏/右下统计条放"操作与指标"。
 *
 * 数据通路（两条，页面里只差一个对象）：
 *   真机：HID 0x32 配置/启停（AkaLinkHid） + WebUSB 0x83 收流（VendorEpTransport）
 *   假机：同一个 MockScopeProbe 既当 HID 又当数据源（MockTransport 注入它）
 *   → 所以"假探针能跑通"就等于整条链路（配置 → 组包 → 收流 → 解码 → 缓冲 → 画图）跑通，
 *     这也是本页能在没有硬件时自测的原因。
 *
 * 采样是**一次性窗口**（线性缓冲，满了就停）：容量 = 名义速率 × 时长 × 1.25。
 * 满了之后新样本计入 `overrun` 并显示在"丢样本"里 —— 绝不静默丢。
 */
import { $, setStatus, seg } from '../ui/dom.js';
import { AkaLinkHid } from '../hid/probe.js';
import { Elf } from '../elf/elf.js';
import { listSampleable } from '../elf/dwarf.js';
import * as P from './protocol.js';
import { SampleStore, Trigger, TRIG, TRIG_NAME, findTrigger, windowFor } from './store.js';
import { ScopeRenderer, legendRows, fmtTime, fmtVal, fmtHz } from './render.js';
import { VendorEpTransport, MockTransport } from './transport.js';
import { MockScopeProbe } from './mock.js';
import { bytes as fmtBytes, fileStamp, download } from '../core/format.js';

/** SWD 时钟档位：与 RTT Viewer 的 WebUSB 那档同款（0 = 自动）*/
const CLOCKS = [[0, '自动'], [1000, '1 MHz'], [5000, '5 MHz'], [10000, '10 MHz'], [20000, '20 MHz'],
                [30000, '30 MHz'], [40000, '40 MHz'], [45000, '45 MHz'], [50000, '50 MHz'], [60000, '60 MHz']];

const MAX_VARS = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class ScopeView {
  /** @param {{mockFactory?:Function}} opts 自测可以换一个"带丢包/会卡住"的假探针 */
  constructor(opts = {}){
    this.mockFactory = opts.mockFactory || (o => new MockScopeProbe(o));
    this.elf = null;
    this.all = [];          // 所有可采样通道
    this.skipped = [];
    this.selected = [];     // 勾选的（≤8）
    this.hid = null;        // 真：AkaLinkHid；假：MockScopeProbe
    this.transport = null;
    this.mockProbe = null;
    this.usingMock = false;
    this.store = null;
    this.renderer = null;
    this.stream = new P.PacketStream();
    this.seqT = new P.SeqTracker();
    this.timeU = new P.TimeUnwrap();
    this.trigger = new Trigger();
    this.defVars = null;
    this.raw = [];
    this.captureRaw = false;
    this.running = false;
    this.state = '空闲';
    this.packets = 0;
    this.lost = 0;
    this.decodeErr = 0;
    this.probeDropped = 0;
    this.swdMhz = 0;
    this.periodActualUs = 0;
    this._raf = 0;
    this._needDraw = true;
    this._lastPktT = null;      // 上一包的起始时刻 / 帧数（用来估包内真实间隔，见 DATA 分支）
    this._lastPktN = 0;
  }

  // ================================================================= 初始化
  init(){
    this.canvas = $('sc-canvas');
    this.renderer = new ScopeRenderer(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.elfInput = this._fileInput('.elf,.axf', f => this.loadElfFile(f));
    this.jspInput = this._fileInput('.jsp,.bin', f => this.replayFile(f));

    // 时钟下拉
    const clk = $('sc-clock');
    for (const [v, label] of CLOCKS){
      const o = document.createElement('option');
      o.value = String(v); o.textContent = label;
      clk.appendChild(o);
    }
    clk.value = '0';

    // 触发模式 / 通道
    const tm = $('sc-trig-mode');
    for (const [v, label] of Object.entries(TRIG_NAME)){
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      tm.appendChild(o);
    }
    tm.value = String(TRIG.NONE);

    $('sc-connect').addEventListener('click', () => this.connectHid(true));
    $('sc-reconnect').addEventListener('click', () => this.connectHid(false));
    $('sc-usb').addEventListener('click', () => this.connectUsb(true));
    $('sc-mock').addEventListener('change', e => this.setMock(e.target.checked));
    $('sc-elf').addEventListener('click', () => this.elfInput.click());
    $('sc-varclear').addEventListener('click', () => { this.selected = []; this.renderVars(); this.updatePlan(); });
    $('sc-search').addEventListener('input', () => this.renderVars());
    $('sc-start').addEventListener('click', () => this.start());
    $('sc-stop').addEventListener('click', () => this.stop());
    $('sc-bench').addEventListener('click', () => this.bench());
    $('sc-recc').addEventListener('click', () => this.applyRecPeriod());
    $('sc-clear').addEventListener('click', () => this.clear());
    $('sc-fit').addEventListener('click', () => { this.renderer.fitAll(); this.follow = true; this._needDraw = true; });
    $('sc-zin').addEventListener('click', () => { this.renderer.zoomBy(1.6, 0.5); this._needDraw = true; });
    $('sc-zout').addEventListener('click', () => { this.renderer.zoomBy(1 / 1.6, 0.5); this._needDraw = true; });
    $('sc-zoompts').addEventListener('click', () => this.zoomToPoints());
    $('sc-shared').addEventListener('change', e => { this.renderer.mode = e.target.checked ? 'shared' : 'auto'; this._needDraw = true; });
    // 叠加 / 分道：分道 = 每通道一条泳道、各自独立量程（多通道混合单位的正解）
    this._layoutSeg = seg(document.querySelector('[data-group=sclayout]'), 'overlay', v => {
      this.renderer.layout = v;
      this.renderer._ranges = [];            // 换布局时丢掉防抖缓存，避免量程残留
      this._needDraw = true;
      this.setStatusText(v === 'lanes'
        ? `分道显示：${this.renderer.visibleCount?.() ?? '各'}通道各占一条泳道，每条自己的量程`
        : '叠加显示：所有通道画在同一片区域', '');
    });
    $('sc-mark-clear').addEventListener('click', () => {
      if (!this.renderer.cursors.a && !this.renderer.cursors.b){ this.setStatusText('还没有放游标：点一下波形放 A、Shift+点放 B', 'warn'); return; }
      this.renderer.clearMarks();
      this._needDraw = true;
      this.setStatusText('已清除测量游标 A/B', '');
    });
    $('sc-raw').addEventListener('change', e => { this.captureRaw = e.target.checked; if (!this.captureRaw) this.raw = []; });
    $('sc-csv').addEventListener('click', () => this.exportCsv());
    $('sc-save').addEventListener('click', () => this.saveRaw());
    $('sc-open').addEventListener('click', () => this.jspInput.click());
    $('sc-trig-find').addEventListener('click', () => this.findNextTrigger());
    $('sc-trig-clear').addEventListener('click', () => this.clearTrigger());
    for (const id of ['sc-trig-mode', 'sc-trig-ch', 'sc-trig-level', 'sc-trig-pre', 'sc-trig-post', 'sc-trig-single']){
      $(id).addEventListener('change', () => this.applyTrigger());
    }

    this._wireCanvas();
    this._wireKeys();
    this.renderVars();
    this.updatePlan();
    this.syncButtons();
    this._loop();
  }

  _fileInput(accept, onFile){
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.hidden = true;
    inp.addEventListener('change', () => { const f = inp.files?.[0]; if (f) onFile(f); inp.value = ''; });
    document.body.appendChild(inp);
    return inp;
  }

  _wireCanvas(){
    const c = this.canvas;
    let dragging = false, lastX = 0, moved = 0, grab = null, shiftClick = false;
    /** 鼠标落在哪条测量游标上（±5 px 内算抓住它）*/
    const markNear = x => {
      for (const which of ['a', 'b']){
        const m = this.renderer.markAt(which);
        if (m && Math.abs(this.renderer.xOf(m.index) - x) <= 5) return which;
      }
      return null;
    };
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left - this.renderer.padding.l) / this.renderer.plotW));
      this.renderer.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, frac);
      this.follow = false;                      // 手动缩放即退出"跟随最新"
      this._needDraw = true;
    }, { passive: false });
    c.addEventListener('mousedown', e => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      grab = e.button === 0 ? markNear(x) : null;      // 抓在游标线上 = 拖它，不是平移
      dragging = !grab; lastX = e.clientX; moved = 0; shiftClick = e.shiftKey;
      c.style.cursor = grab ? 'ew-resize' : 'grabbing';
    });
    window.addEventListener('mouseup', e => {
      if (grab){ dragging = false; grab = null; c.style.cursor = 'crosshair'; return; }
      if (!dragging) return;
      dragging = false; c.style.cursor = 'crosshair';
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (moved >= 4 || !this.store?.count) return;    // 拖动过 = 平移，不当点击
      if (x < this.renderer.padding.l || x > c.clientWidth - this.renderer.padding.r) return;
      // 单击放 A、Shift+单击放 B（量周期就靠这两条线）
      const which = shiftClick ? 'b' : 'a';
      const idx = Math.round(this.renderer.sampleAt(x));
      const at = this.renderer.setMark(which, idx);
      this._needDraw = true;
      const d = this.renderer.delta();
      this.setStatusText(d
        ? `游标 ${which.toUpperCase()} 放在样本 #${at} · Δt ${fmtTime(d.absUs)} → ${fmtHz(d.hz)}`
        : `游标 ${which.toUpperCase()} 放在样本 #${at}（再 ${which === 'a' ? 'Shift+' : ''}点一下放 ${which === 'a' ? 'B' : 'A'} 就能量间隔）`, '');
    });
    window.addEventListener('mousemove', e => {
      const r = c.getBoundingClientRect();
      if (grab){
        const x = e.clientX - r.left;
        if (x >= this.renderer.padding.l && x <= c.clientWidth - this.renderer.padding.r){
          this.renderer.setMark(grab, Math.round(this.renderer.sampleAt(x)));
          this._needDraw = true;
        }
        return;
      }
      if (dragging){
        const dx = e.clientX - lastX;
        lastX = e.clientX; moved += Math.abs(dx);
        this.renderer.panBy(-dx / this.renderer.plotW * this.renderer.span);
        this.follow = false;
        this._needDraw = true;
        return;
      }
      if (!this.store) return;
      const x = e.clientX - r.left;
      if (x < this.renderer.padding.l || x > c.clientWidth - this.renderer.padding.r){ this.renderer.cursor = null; this._needDraw = true; return; }
      const idx = Math.round(this.renderer.sampleAt(x));
      this.renderer.cursor = (idx >= 0 && idx < this.store.count) ? idx : null;
      this._needDraw = true;
    });
    c.addEventListener('dblclick', () => { this.renderer.fitAll(); this.follow = true; this._needDraw = true; });
  }

  onShow(){
    requestAnimationFrame(() => { this._needDraw = true; });
  }

  /** 键盘：Esc 清测量游标、Home/End 跳首尾（只在探针页可见、焦点不在输入框时生效）*/
  _wireKeys(){
    window.addEventListener('keydown', e => {
      const tab = document.getElementById('tab-scope');
      if (!tab || !tab.classList.contains('active')) return;      // 切页由 tabs.js 管（.active）
      const t = e.target;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const st = this.store;
      if (e.key === 'Escape'){
        if (!this.renderer.cursors.a && !this.renderer.cursors.b && this.renderer.cursor == null) return;
        const had = !!(this.renderer.cursors.a || this.renderer.cursors.b);
        this.renderer.clearMarks();
        this.renderer.cursor = null;
        this._needDraw = true;
        if (had) this.setStatusText('已清除测量游标 A/B', '');
        return;
      }
      if (!st?.count) return;
      if (e.key === 'Home' || e.key === 'End'){
        const w = Math.min(st.count, Math.round(this.renderer.span));
        const start = e.key === 'Home' ? 0 : Math.max(0, st.count - w);
        this.follow = false;
        this.renderer.zoomTo(start, start + w);
        this._needDraw = true;
        e.preventDefault();
      }
    });
  }

  /** 「细看」：把视窗缩到"每列约 1 个采样点"，这时渲染器走**折线连点**模式 ——
   *  看慢信号（100 Hz 正弦这类）的波形形状要靠它，全览时看到的是包络带。 */
  zoomToPoints(){
    const st = this.store;
    if (!st?.count){ this.setStatusText('还没有数据', 'warn'); return; }
    const w = Math.max(64, Math.round(this.renderer.plotW));
    const end = st.count;
    this.follow = false;
    this.renderer.zoomTo(Math.max(0, end - w), end);
    this._needDraw = true;
    this.setStatusText(`细看：${Math.round(this.renderer.span)} 个样本铺满 ${w} 列（≈1 点/列）`, '');
  }

  // ================================================================= 连接
  async connectHid(request){
    if (this.usingMock){ this.setStatusText('假探针模式下不需要连真探针', 'warn'); return; }
    try {
      if (!AkaLinkHid.supported()) throw new Error('这个浏览器没有 WebHID（桌面版 Chrome / Edge 才有）');
      const hid = new AkaLinkHid();
      // 探针被复位/拔插 → 浏览器会发 disconnect：立刻把状态写清楚，别等用户点开始采样才报一句英文错
      hid.onDisconnect = () => {
        this.setStatusText('探针断开了（被复位、拔插或掉电？）—— 点「重连」，或拔插一次探针', 'err');
        $('sc-info').textContent = '探针已断开';
        if (this.running) this.stop().catch(() => {});
      };
      if (request) await hid.request(); else await hid.reconnect();
      this.hid = hid;
      let info = '';
      try { const i = await hid.info(); info = `${i.model || 'akaLinkPro'}${i.fw ? ' · FW ' + i.fw : ''}`; }
      catch {
        // 连上了但问不出型号 —— 十有八九选错了设备（触摸板/键盘也有 0xFF00 的 collection）
        info = hid.label || '未知 HID 设备';
        $('sc-info').textContent = info + '（HID 已连接，但**问不出型号**）';
        this.setStatusText(`连到的 HID 设备是「${info}」，但它不响应探针协议 —— ` +
          '选错设备了？请点「连接探针」并在弹框里选 **akaLinkPro**', 'err');
        return;
      }
      $('sc-info').textContent = info + '（HID 已连接）';
      this.setStatusText(`探针已连接：${info}`, hid.isProbe ? 'ok' : 'warn');
      if (!hid.isProbe){
        $('sc-info').textContent = info + '（HID 已连接 · ⚠ 不是 akaLinkPro 的 VID/PID）';
        this.setStatusText(`⚠ 连到的是「${info}」（VID/PID 不是 0d28:0204）—— 可能选错设备了`, 'warn');
      }
    } catch (e){
      this.setStatusText('连接探针失败：' + (e?.message || e), 'err');
    }
  }

  /**
   * 连数据端点（WebUSB 的 0x83）。
   * request=true 弹设备框；false 时先用浏览器**已授权**的设备直接连
   * （和 HID 的「重连」一个道理：授权过一次就不用再点弹框，自动化测试也走这条路）。
   */
  async connectUsb(request = true){
    if (this.usingMock){ this.setStatusText('假探针模式下不需要数据端点', 'warn'); return; }
    try {
      if (request){
        this.transport = await VendorEpTransport.request();
      } else {
        const list = await VendorEpTransport.authorized();
        if (!list.length) throw new Error('浏览器里没有已授权的探针（先点「连接数据端点…」授权一次）');
        this.transport = new VendorEpTransport(list[0]);
        await this.transport.open();
      }
      $('sc-usbinfo').textContent = this.transport.label;
      this.setStatusText('数据端点已就绪：' + this.transport.label, 'ok');
    } catch (e){
      this.transport = null;                    // 没认领成功就别留着一个"半开"的对象：start() 会误以为能用
      $('sc-usbinfo').textContent = '连接失败：' + (e?.message || e);
      this.setStatusText('连接数据端点失败：' + (e?.message || e), 'err');
    }
  }

  setMock(on){
    this.usingMock = !!on;
    this.running = false;
    if (on){
      this.mockProbe = this.mockProbe || this.mockFactory({ periodUs: this.periodUs(), startDelayPolls: 1 });
      this.hid = this.mockProbe;
      this.transport = new MockTransport({ probe: this.mockProbe });
      $('sc-info').textContent = '假探针（无需硬件）';
      $('sc-usbinfo').textContent = '假探针模式：数据由页面生成';
      this.setStatusText('已切到假探针：选变量 → 开始采样 即可看到波形', 'ok');
    } else {
      this.hid = null;
      this.transport = null;
      $('sc-info').textContent = '未连接';
      $('sc-usbinfo').textContent = '未连接数据端点（假探针模式不需要）';
      this.setStatusText('已切回真机模式：先连探针，再连数据端点', '');
    }
    this.syncButtons();
  }

  // ================================================================= ELF / 变量
  async loadElfFile(file){
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const elf = new Elf(buf);
      const r = listSampleable(elf);
      this.elf = { name: file.name, source: r.source, versions: r.versions, stats: r.stats };
      this.all = r.sampleable;
      this.skipped = r.skipped;
      this.selected = this.selected.filter(v => this.all.some(a => a.name === v.name && a.addr === v.addr));
      $('sc-elfinfo').textContent =
        `${file.name} · ${r.source === 'dwarf' ? `DWARF ${r.versions.join('/')}` : '符号表（无调试信息）'} · ` +
        `可采样 ${r.sampleable.length} 个 · 采不了 ${r.skipped.length} 个`;
      this.renderVars();
      this.updatePlan();
      this.setStatusText(`ELF 解析完成：${r.sampleable.length} 个可采样通道`, 'ok');
    } catch (e){
      $('sc-elfinfo').textContent = '解析失败：' + (e?.message || e);
      this.setStatusText('ELF 解析失败：' + (e?.message || e), 'err');
    }
  }

  renderVars(){
    const box = $('sc-vars');
    if (!box) return;
    const q = ($('sc-search').value || '').trim().toLowerCase();
    const list = this.all.filter(v => !q || v.name.toLowerCase().includes(q));
    box.innerHTML = '';
    if (!this.all.length){
      box.innerHTML = '<div class="vsect">还没有变量：点「载入 ELF…」，或勾「用假探针」用内置的 8 个通道</div>';
    }
    for (const v of list.slice(0, 400)){
      const sel = this.selected.some(s => s.name === v.name && s.addr === v.addr);
      const row = document.createElement('label');
      row.className = 'vrow' + (sel ? ' sel' : '') + (!sel && this.selected.length >= MAX_VARS ? ' dis' : '');
      row.innerHTML = `<input type="checkbox" ${sel ? 'checked' : ''} ${!sel && this.selected.length >= MAX_VARS ? 'disabled' : ''}>` +
        `<span class="nm" title="${v.name}">${v.name}</span>` +
        `<span class="ty">${v.scalar || v.typeName || '?'}</span>` +
        `<span class="ad">0x${v.addr.toString(16)}</span>`;
      row.querySelector('input').addEventListener('change', e => this.toggleVar(v, e.target.checked));
      box.appendChild(row);
    }
    if (list.length > 400){
      const more = document.createElement('div');
      more.className = 'vsect';
      more.textContent = `还有 ${list.length - 400} 个没显示 —— 用上面的搜索框缩小范围`;
      box.appendChild(more);
    }
    if (this.skipped.length){
      const s = document.createElement('div');
      s.className = 'vsect';
      const g = this.skipped.slice(0, 3).map(x => `${x.name}（${x.reason}）`).join('；');
      s.textContent = `采不了 ${this.skipped.length} 个，例如：${g}`;
      box.appendChild(s);
    }
    $('sc-count').textContent = `已选 ${this.selected.length} / ${MAX_VARS}`;
  }

  toggleVar(v, on){
    if (on){
      if (this.selected.length >= MAX_VARS){ this.setStatusText(`最多选 ${MAX_VARS} 个变量（8 个正好装进一条 HID 配置报文）`, 'warn'); this.renderVars(); return; }
      if (!this.selected.some(s => s.name === v.name && s.addr === v.addr)) this.selected.push(v);
    } else {
      this.selected = this.selected.filter(s => !(s.name === v.name && s.addr === v.addr));
    }
    this.renderVars();
    this.updatePlan();
  }

  updatePlan(){
    const vars = this.selected.length ? this.selected : this.mockVars();
    const plan = P.planReads(vars);
    this.plan = plan;
    const khz = Math.round(plan.estHz / 1000);
    // 单变量 4 字节：固件有条"抱住 TAR + 流水读"的快路径（每拍只 1 次传输），
    // 实测 ≈1.6 µs @60 MHz / ≈3.1 µs @45 MHz —— 模型那 6.7 µs 是按"3 次传输"算的，偏保守。
    const fast = plan.spans.length === 1 && plan.frameBytes === 4;
    $('sc-plan').innerHTML = vars.length
      ? `读计划：${plan.spans.length} 个 span / 帧 ${plan.frameBytes} B · ` +
        `模型估算 ≈${plan.estUs.toFixed(1)} µs/样本 → ≈${khz} kHz（**偏保守**：单字 span 有快路径，实测 ≈1.6 µs → 600 kHz 量级）` +
        (plan.saved > 0.15 ? `（合并省了 ${(plan.saved * 100).toFixed(0)}%）` : '') +
        (this.benchUs ? ` · <b>已标定：读一次 ${this.benchUs.toFixed(3)} µs</b>（上限 ${Math.round(1e3 / this.benchUs)} kHz，建议周期 ≥ ${this.recPeriodUs} µs）` : '') +
        '（周期下限 2 µs；周期 < 读一次 的耗时就会跳拍丢样本）'
      : '选好变量后会显示读计划与预计上限';
    // 触发通道下拉跟着变量走
    const sel = $('sc-trig-ch');
    const want = vars.map(v => v.name);
    if (sel.options.length !== want.length || [...sel.options].some((o, i) => o.value !== String(i) || o.textContent !== want[i])){
      sel.innerHTML = '';
      want.forEach((n, i) => {
        const o = document.createElement('option');
        o.value = String(i); o.textContent = `${i}: ${n}`;
        sel.appendChild(o);
      });
    }
    return plan;
  }

  /** 假探针内置的 8 个通道（没载 ELF 时给界面用）*/
  mockVars(){
    const sc = ['f32', 'f32', 'i32', 'u16', 'i16', 'u8', 'i8', 'f64'];
    return sc.map((s, i) => ({ name: `mock${i}.${s}`, addr: 0x20000000 + i * 4, size: P.SCALARS[s].size, scalar: s }));
  }

  periodUs(){ return Math.max(2, Number($('sc-period').value) || 100); }   // 固件下限是 2 µs（整数微秒）
  seconds(){ return Math.max(0.5, Number($('sc-seconds').value) || 20); }

  // ================================================================= 采样
  async start(){
    const pick = (this.selected.length ? this.selected : (this.usingMock ? this.mockVars() : []));
    /**
     * 🚨 **必须按地址排序后再建缓冲**：固件把变量按**地址顺序**紧排在帧里（协议规定），
     *    DEF 里那张表也是地址顺序。而"勾选顺序"是用户随手点的 —— 两者不一致时，
     *    通道和数据会**整体错位**（实测：先勾 u_ramp(0x…20) 再勾 f_sin(0x…14)，
     *    结果 u_ramp 那一格装的是 f_sin 的 ±1，f_sin 那格装的是锯齿 0..999，
     *    图表和标签全对不上 —— 而且只在"勾选顺序 ≠ 地址顺序"时才出现，很容易漏）。
     */
    const vars = [...pick].sort((a, b) => a.addr - b.addr);
    if (!vars.length){ this.setStatusText('先选变量（或用假探针自带的通道）', 'warn'); return; }
    if (!this.transport || !this.hid){ this.setStatusText(this.usingMock ? '假探针还没准备好' : '先连探针 + 数据端点', 'warn'); return; }
    if (this.isReal() && !this.transport?.device){ this.setStatusText('真机模式要先点「连接数据端点…」', 'warn'); return; }

    const periodUs = this.periodUs();
    const nominalHz = 1e6 / periodUs;
    let capacity = Math.ceil(nominalHz * this.seconds() * 1.25) + 64;
    /**
     * 🚨 内存闸：周期可以设到 2 µs、时长可以设到几百秒，两者一乘就是几千万样本 ——
     *    8 通道 × 2 B × 1200 万 = 两百多 MB，标签页会卡死甚至崩。
     *    这里按"每样本字节数 × 通道数 × 1.35（LOD 开销）"估一下，超了就把容量砍到 256 MB 以内
     *    并**明说**砍了多少（宁可少存点，也不能让页面挂掉还不知道为什么）。
     */
    const bytesPerFrame = vars.reduce((s, v) => s + (P.SCALARS[v.scalar]?.size || 4), 0);
    const LIMIT = 128 * 1024 * 1024;
    let capNote = '';
    const est = cap => cap * bytesPerFrame * 1.35 + vars.length * 8192;
    if (est(capacity) > LIMIT){
      const capped = Math.max(1024, Math.floor((LIMIT - vars.length * 8192) / (bytesPerFrame * 1.35)));
      capNote = `　⚠️ 缓冲按内存上限（128 MB）从 ${capacity} 收到 ${capped} 个样本` +
        `（${((capped / nominalHz)).toFixed(2)} s @${(nominalHz / 1000).toFixed(1)} kHz）`;
      capacity = capped;
    }
    // 线速闸：探针的 0x83 有个已知的"包率天花板"（~1.75 MB/s，每包 512 B 装 floor(496/frame) 个样本）。
    // 超了不是采样不够快，而是**主机侧排空不及**——丢的是 USB 那笔账，界面要把它和探针跳拍分开说。
    const wireBps = bytesPerFrame * nominalHz;
    const wireNote = wireBps > 1.6e6
      ? `　⚠️ 线速 ≈${(wireBps / 1048576).toFixed(2)} MB/s，超过 0x83 的包率天花板（≈1.75 MB/s）——` +
        '丢样本会是"USB 排空不及"这笔账（STAT 的 usb_drop），不是探针读不过来'
      : '';
    this.plan = this.updatePlan();
    this.defVars = null;
    this._periodUs = periodUs;
    this._capacity = capacity;
    this.store = new SampleStore(vars, capacity);
    this.renderer.setStore(this.store);
    this.renderer.setTrigger(null);
    this.renderer.clearMarks();     // 新的一轮 = 新的样本编号，旧游标位置没意义
    this.renderer.cursor = null;
    this._lastPktT = null; this._lastPktN = 0;    // 包内间隔估计也要重新起头（见 DATA 分支）
    this.stream = new P.PacketStream();
    this.seqT = new P.SeqTracker();
    this.timeU = new P.TimeUnwrap();
    this._awaitDef = true;          // 起跑线：丢掉上一轮的残留包，等新一轮的 DEF
    this.stalePackets = 0;
    this.trigger = new Trigger();
    this.applyTrigger(true);
    this.packets = 0; this.lost = 0; this.decodeErr = 0; this.probeDropped = 0; this.raw = [];
    this.rawBytes = 0;

    try {
      const clockKhz = Number($('sc-clock').value) || 0;
      // flags：bit0 允许 60 MHz；bit5 采样期间自动暂停 CDC/串口桥（探针主循环那几百周期）
      const flags = (clockKhz >= 60000 ? 1 : 0) | ($('sc-cdcoff')?.checked ? 0x20 : 0);
      if (clockKhz > 0) await this.hidXfer(P.HID_CMD, P.clockData(clockKhz * 1000));
      await this.hidXfer(P.HID_CMD, P.configData({ periodUs, flags, vars }));

      /**
       * 🚨 **先开数据面读，再让探针开跑** —— 顺序反了会丢起跑线。
       *    真机实测的教训：早先先发 START、再轮询 STATUS 等启动码（那是 120~240 ms），
       *    这期间探针已经灌了几百个包，而设备只有 4 个包缓冲 ⇒ 最先发出的 **DEF 包
       *    早就被丢掉**，于是"等 DEF 当起跑线"的守卫永远等不到、新采集一个样本都没有。
       *    现在先 start() 读起来（顺便把上一轮的残留吃掉），再发 START。
       */
      await this.transport.start(chunk => this.onChunk(chunk));
      this._awaitDefSince = performance.now();

      let rc = P.START_PENDING;
      await this.hidXfer(P.HID_CMD, P.flagsData(P.ACT.START));
      for (let i = 0; i < 20 && rc === P.START_PENDING; i++){    // -100 = 排队中，轮询等结果
        await sleep(120);
        const res = await this.hidXfer(P.HID_CMD, P.flagsData(P.ACT.STATUS));
        rc = this.signed(res?.[2]);
      }
      if (rc < 0 && rc !== P.START_PENDING){
        await this.transport.stop().catch(() => {});
        this.setStatusText('探针启动失败：' + P.scopeRcText(rc), 'err');
        return;
      }
      this.running = true;
      this.follow = true;
      this.state = '采样中';
      // 周期比"读一次"还短 ⇒ 必丢拍（固件侧的账），这一条要当面说清楚
      const tooFast = (this.benchUs && periodUs < this.benchUs)
        ? `　⚠️ 周期 ${periodUs} µs 小于"读一次"的 ${this.benchUs.toFixed(2)} µs，探针会跳拍丢样本（建议 ≥ ${this.recPeriodUs} µs）` : '';
      this.setStatusText(`采样中：${vars.length} 通道 × ${(1e6 / periodUs / 1000).toFixed(2)} kHz，缓冲 ${capacity} 样本` +
        (this.trigger.mode !== TRIG.NONE ? '（触发已布防）' : '') + tooFast + wireNote + capNote,
      (tooFast || wireNote || capNote) ? 'warn' : 'ok');
    } catch (e){
      this.running = false;
      try { await this.transport?.stop(); } catch { /* 忽略 */ }
      this.setStatusText('启动失败：' + (e?.message || e), 'err');
    }
    this.syncButtons();
    this._needDraw = true;
  }

  async stop(){
    if (!this.running && !this.transport?.running) return;
    this.running = false;
    try { await this.transport.stop(); } catch { /* 忽略 */ }
    try { await this.hidXfer(P.HID_CMD, P.flagsData(P.ACT.STOP)); } catch { /* 忽略 */ }
    this.state = '已停止';
    this.setStatusText(`已停止：${this.store?.count || 0} 个样本` +
      (this.lost ? `，丢 ${this.lost} 个（seq 缺口）` : '，零丢包'), this.lost ? 'warn' : 'ok');
    this.syncButtons();
    this._needDraw = true;
  }

  /** 探针侧标定：用当前计划空跑，回报每样本的真实耗时（M0）。
   *  🚨 必须**先**把当前 UI 上的周期/变量表/时钟发下去 —— 否则标定测的是**上一次**的配置
   *     （真机实测：单变量那次报 11.088 µs，8 通道那次报 1.522 µs，正好是对方的数）。
   *  顺带读固件回报的 **实际装载了哪个 blob** 与 `clock_delay` —— 没有这个数就分不出
   *  "时钟命令被忽略" 和 "生效了但没差别"（他们的 README 里就是被这个坑咬过）。*/
  async bench(){
    if (!this.hid){ this.setStatusText('先连探针', 'warn'); return; }
    try {
      const vars = (this.selected.length ? this.selected : (this.usingMock ? this.mockVars() : []));
      if (!vars.length){ this.setStatusText('先选变量再标定（标定用的是当前计划）', 'warn'); return; }
      const clockKhz = Number($('sc-clock').value) || 0;
      const flags = (clockKhz >= 60000 ? 1 : 0) | ($('sc-cdcoff')?.checked ? 0x20 : 0);
      if (clockKhz > 0) await this.hidXfer(P.HID_CMD, P.clockData(clockKhz * 1000));
      await this.hidXfer(P.HID_CMD, P.configData({ periodUs: this.periodUs(), flags, vars }));
      this.plan = this.updatePlan();
      await this.hidXfer(P.HID_CMD, P.benchData({ iters: 2000 }));
      await sleep(600);
      const res = await this.hidXfer(P.HID_CMD, Uint8Array.of(P.ACT.BENCH_RESULT));
      const dv = new DataView(res.buffer, res.byteOffset, res.byteLength);
      const ticks = dv.getUint32(3, true), iters = dv.getUint32(7, true), err = dv.getInt32(11, true);
      const blob = dv.getUint32(15, true), delay = dv.getUint32(19, true);
      const usPerSample = iters ? (ticks / 24) / iters : 0;
      this.benchUs = usPerSample;
      /**
       * 建议周期 = 单次采样耗时 × 1.15 + 1 µs（留余量给探针主循环的 USB/HID/按键那些活）。
       * 为什么要"+1"而不是纯比例：周期贴着耗时跑，主循环里一有别的活儿就跳拍丢样本；
       * 实测单变量 1.54 µs 时 2 µs 档会丢 ~11%，而 3 µs 档是零丢 —— 所以给一个绝对余量。
       * 下限 3 µs（固件钳位是 2 µs，但 2 µs 只建议在"就想要最高速率、接受丢样本"时用）。
       */
      this.recPeriodUs = usPerSample > 0 ? Math.max(3, Math.ceil(usPerSample * 1.15) + 1) : null;
      const blobName = { 0x53c: '60M(6 指令/bit)', 0x60c: '45M(8)', 0x6e0: '36M(10)', 0x7c4: '30M(12)',
                         0xa54: '20M(18)', 0x620: 'SLOW', 0xffffffff: '还没装载' }[blob] || `0x${blob.toString(16)}`;
      this.blob = { offset: blob, name: blobName, delay };
      this.setStatusText(`标定：读一次 ${usPerSample.toFixed(3)} µs → 上限 ≈${Math.round(1e3 / usPerSample)} kHz` +
        `（blob ${blobName}，clock_delay=${delay}${err ? `，err=${err}` : ''}）；` +
        `**建议周期 ≥ ${this.recPeriodUs} µs**（≈${Math.round(1e3 / this.recPeriodUs)} kHz，零丢档）`, 'ok');
    } catch (e){
      this.setStatusText('标定失败：' + (e?.message || e), 'err');
    }
  }

  /** 把周期填成标定给出的建议值（没标定过就先标一次） */
  async applyRecPeriod(){
    if (!this.recPeriodUs){ await this.bench(); }
    if (!this.recPeriodUs){ this.setStatusText('先点「标定真实速率」', 'warn'); return; }
    $('sc-period').value = String(this.recPeriodUs);
    this.updatePlan();
    this.setStatusText(`周期已设为 ${this.recPeriodUs} µs（≈${Math.round(1e3 / this.recPeriodUs)} kHz，按标定值留了 25% 余量）`, 'ok');
  }

  isReal(){ return !this.usingMock; }
  signed(v){ const x = (v ?? 0) & 0xff; return x > 127 ? x - 256 : x; }
  async hidXfer(cmd, data, timeout){
    if (!this.hid) throw new Error('探针没连上');
    if (this.usingMock) return await this.hid.xfer(cmd, data);
    return await this.hid.xfer(cmd, data, timeout);
  }

  /** 数据面回调：字节流 → 包 → 解码 → 缓冲（+触发 +统计）*/
  onChunk(chunk){
    if (this.captureRaw){
      const copy = chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk);
      this.raw.push(copy); this.rawBytes = (this.rawBytes || 0) + copy.length;
    }
    for (const pkt of this.stream.push(chunk)){
      /**
       * 🚨 **等 DEF 当"起跑线"**：探针的 4 个包缓冲和主机侧在飞的读里，
       *    可能还留着**上一轮**没取走的包（上一轮的帧长/变量表都可能不同）。
       *    真机上就撞到了：上一轮是单变量（4 B 帧），新的一轮是 8 通道（26 B 帧），
       *    残留的 4 B 流被按 26 B 解 → 前 100 多个样本是垃圾，
       *    而且时间戳往回跳 → `TimeUnwrap` 以为绕了 32 位 → 实测速率算成 55 Hz。
       *    每次 start 探针都会**先发一个 DEF**，拿它当新一轮的起跑线最可靠。
       */
      if (this._awaitDef){
        if (pkt.kind !== P.KIND.DEF){
          this.stalePackets = (this.stalePackets || 0) + 1;
          // 兜底：1.5 s 还没等到 DEF 就别死等（万一固件版本不发 DEF），
          // 退化成"按本地变量表解码"，并在状态栏说清楚 —— 而不是一个样本都没有还不解释
          if (this._awaitDefSince && performance.now() - this._awaitDefSince > 1500){
            this._awaitDef = false;
            this.setStatusText(`没等到探针的 DEF 包（已丢 ${this.stalePackets} 个残留包），` +
              '按本地变量表解码 —— 波形若有错位请检查固件版本', 'warn');
          } else {
            continue;
          }
        } else {
          this._awaitDef = false;
        }
      }
      this.packets++;
      const st = this.seqT.note(pkt.seq);
      if (!st.ok && st.why === 'gap') this.lost += st.missing || 1;
      switch (pkt.kind){
        case P.KIND.DEF: {
          const d = P.parseDef(pkt.payload);
          this.defVars = d.vars;
          this.periodActualUs = d.periodUs;
          this.swdMhz = d.swdHz ? Math.round(d.swdHz / 1e6) : this.swdMhz;
          // 探针回报的 span 数 vs 本地计划：不一致就说明两边的合并规则不一样了（改一边忘了另一边）
          if (d.spans && this.plan && d.spans !== this.plan.spans.length){
            this.planMismatch = `探针算出 ${d.spans} 个 span，本地计划是 ${this.plan.spans.length} 个`;
          } else {
            this.planMismatch = null;
          }
          /**
           * 🚨 **变量个数对不上就别解码**：说明配置没生效（或这一包是上一轮的残留）。
           *    硬解下去就是"通道与数据整体错位"的垃圾波形（实测踩过），
           *    宁可报错停在这儿 —— 数据错了比没数据更坏。
           */
          const want = this.store?.vars.length || 0;
          if (want && d.vars.length !== want){
            this.defMismatch = `探针回报 ${d.vars.length} 个变量，本地缓冲是 ${want} 个 —— 解码已暂停（配置没生效？）`;
            this.setStatusText('⚠ ' + this.defMismatch, 'err');
          } else {
            this.defMismatch = null;
          }
          break;
        }
        case P.KIND.DATA: {
          if (this.defMismatch) break;              // 变量表对不上：不解码（见 DEF 分支的说明）
          const vars = this.defVars || this.store?.vars;
          if (!vars?.length) break;
          const nums = P.decodeSamples(vars, pkt.payload, pkt.n, []);
          const nv = vars.length;
          const t0 = this.timeU.unwrap(pkt.tUs);
          /**
           * 包内每个样本的时刻：用**上一包实测出来的间隔**折算，而不是配置里的名义周期。
           * 探针的实际节奏会飘（真机实测同一次采集里 10.00 → 10.31 µs/样本），
           * 死套名义值会让包内 20 来个样本最多偏 6 µs —— 量周期时就是白送的误差。
           * 只在"上一包紧邻且没丢"时采用（丢包时那个除法的分母就不对了）。
           */
          const nominal = this.periodActualUs || this._periodUs || 100;   // 优先用探针在 DEF 里回报的**实际**周期
          let per = nominal;
          if (this._lastPktT != null && this._lastPktN && st.ok && st.why !== 'gap'){
            const est = (t0 - this._lastPktT) / this._lastPktN;
            if (est > nominal * 0.5 && est < nominal * 2) per = est;    // 离谱就退回名义值
          }
          this._lastPktT = t0; this._lastPktN = pkt.n;
          for (let i = 0; i < pkt.n; i++){
            const fr = nums.slice(i * nv, (i + 1) * nv);
            if (!fr.length) break;
            const idx = this.store.count;
            this.store.pushFrame(fr, t0 + i * per);
            if (this.trigger.mode !== TRIG.NONE && this.trigger.feed(fr, idx)){
              this.renderer.setTrigger({ index: idx, pre: this.trigger.pre, post: this.trigger.post });
            }
          }
          break;
        }
        case P.KIND.STAT: {
          const s = P.parseStat(pkt.payload);
          this.probeDropped = s.dropped;
          this.usbDrop = s.usbErr;                 // 固件 w4 高 16 位 = 无缓冲丢样本（主机排空不及）
          this.probeYield = 0;
          this.swdMhz = s.swdMhz;
          if (s.periodUs) this.periodActualUs = s.periodUs;
          break;
        }
        default: break;
      }
    }
    this._needDraw = true;
  }

  clear(){
    this.store?.reset();
    this.stream = new P.PacketStream();
    this.seqT = new P.SeqTracker();
    this.packets = 0; this.lost = 0; this.decodeErr = 0; this.raw = []; this.rawBytes = 0;
    this.renderer.setTrigger(null);
    // 测量游标按**样本索引**记位置，换了数据集（清空/重采/回放）就必须丢掉，否则指的已经不是那一刻
    this.renderer.clearMarks();
    this.renderer.cursor = null;
    this._lastPktT = null; this._lastPktN = 0;
    this.trigger.reset();
    this.renderer.fitAll();
    this.follow = true;
    this.setStatusText('已清空', '');
    this._needDraw = true;
  }

  // ================================================================= 触发
  trigCfg(){
    return {
      channel: Number($('sc-trig-ch').value) || 0,
      mode: Number($('sc-trig-mode').value) || 0,
      level: Number($('sc-trig-level').value) || 0,
      pre: Math.max(0, Number($('sc-trig-pre').value) || 0),
      post: Math.max(0, Number($('sc-trig-post').value) || 0),
      single: $('sc-trig-single').checked,
    };
  }

  applyTrigger(silent){
    const c = this.trigCfg();
    this.trigger.configure(c);
    if (this.store && this.trigger.mode !== TRIG.NONE){
      // 已经采到的数据立刻重新定位一次（离线重触发）
      const hit = findTrigger(this.store, c, 0);
      if (hit >= 0){
        this.trigger.fired = true; this.trigger.hitIndex = hit;
        this.renderer.setTrigger({ index: hit, pre: c.pre, post: c.post });
        $('sc-trig-state').textContent = `命中 @ 样本 ${hit}（离线重定位）`;
      } else {
        this.renderer.setTrigger(null);
        $('sc-trig-state').textContent = '布防中（等条件满足）';
      }
    } else if (this.renderer){
      this.renderer.setTrigger(null);
      $('sc-trig-state').textContent = '未命中';
    }
    if (!silent && this.isReal() && this.hid){
      // 探针侧触发是 v2（主机侧已经够用），这里只把配置发过去，失败不影响
      this.hidXfer(P.HID_CMD, P.triggerData(c)).catch(() => {});
    }
    this._needDraw = true;
  }

  findNextTrigger(){
    if (!this.store?.count){ this.setStatusText('还没有数据', 'warn'); return; }
    const c = this.trigCfg();
    if (c.mode === TRIG.NONE){ this.setStatusText('先把触发模式选上（现在是"不触发"）', 'warn'); return; }
    const from = (this.trigger.hitIndex >= 0 ? this.trigger.hitIndex + 1 : 0);
    const hit = findTrigger(this.store, c, from);
    if (hit < 0){ this.setStatusText('没有下一个命中点（可以放宽阈值再试）', 'warn'); return; }
    this.trigger.fired = true; this.trigger.hitIndex = hit;
    this.renderer.setTrigger({ index: hit, pre: c.pre, post: c.post });
    const w = windowFor(hit, c.pre, c.post, this.store.count);
    this.follow = false;                 // 🚨 必须关掉"跟随最新"，否则下一帧 fitAll() 会把窗口冲掉
    this.renderer.zoomTo(w.start, w.end);
    $('sc-trig-state').textContent = `命中 @ 样本 ${hit}（窗口 ${w.start}..${w.end}${w.short ? '，预触发不足' : ''}）`;
    this._needDraw = true;
  }

  clearTrigger(){
    this.trigger.reset();
    this.renderer.setTrigger(null);
    $('sc-trig-state').textContent = '未命中';
    this._needDraw = true;
  }

  // ================================================================= 导出 / 回放
  exportCsv(){
    const st = this.store;
    if (!st?.count){ this.setStatusText('还没有数据可导出', 'warn'); return; }
    const n = st.count;
    const head = ['t_us', ...st.vars.map(v => v.name)].join(',');
    const parts = [head + '\n'];
    let buf = '';
    for (let i = 0; i < n; i++){
      const row = [st.timeAt(i).toFixed(0)];
      for (const ch of st.channels) row.push(numToCsv(ch.value(i)));
      buf += row.join(',') + '\n';
      if (buf.length > 1 << 20){ parts.push(buf); buf = ''; }      // 1 MB 一块，别一次拼 200 MB 字符串
    }
    if (buf) parts.push(buf);
    const blob = new Blob(parts, { type: 'text/csv' });
    download(`scope-${fileStamp()}.csv`, blob, 'text/csv');
    this.setStatusText(`已导出 CSV：${n} 行 × ${st.vars.length + 1} 列`, 'ok');
  }

  saveRaw(){
    if (!this.raw.length){ this.setStatusText('没有记录原始包（先勾上「记录原始包」再采样）', 'warn'); return; }
    const blob = new Blob(this.raw, { type: 'application/octet-stream' });
    download(`scope-${fileStamp()}.jsp`, blob, 'application/octet-stream');
    this.setStatusText(`已保存原始包：${this.raw.length} 块 / ${fmtBytes(this.rawBytes || 0)}`, 'ok');
  }

  /** 回放 .jsp：把当时的字节流重新喂一遍（不连硬件也能看波形 / 调触发）*/
  async replayFile(file){
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const vars = [...(this.selected.length ? this.selected : this.mockVars())].sort((a, b) => a.addr - b.addr);
      const periodUs = this.periodUs();
      this.store = new SampleStore(vars, Math.ceil(buf.length / 16) + 1024);
      this.renderer.setStore(this.store);
      this.renderer.clearMarks();
      this.renderer.cursor = null;
      this._lastPktT = null; this._lastPktN = 0;
      this.stream = new P.PacketStream();
      this.seqT = new P.SeqTracker();
      this.timeU = new P.TimeUnwrap();
      this.packets = 0; this.lost = 0; this.defVars = null;
      const chunk = 64 * 1024;
      for (let o = 0; o < buf.length; o += chunk) this.onChunk(buf.subarray(o, o + chunk));
      this.renderer.fitAll();
      this.setStatusText(`回放完成：${this.store.count} 个样本 / ${this.packets} 个包`, 'ok');
      this._needDraw = true;
    } catch (e){
      this.setStatusText('回放失败：' + (e?.message || e), 'err');
    }
  }

  // ================================================================= 界面
  setStatusText(text, kind){
    this.state = text;
    const el = $('sc-state');
    if (el) setStatus(el, text, kind);
    if (kind === 'err'){ const e = $('sc-err'); if (e) e.textContent = text; }
  }

  syncButtons(){
    $('sc-start').disabled = this.running;
    $('sc-stop').disabled = !this.running;
  }

  _loop(){
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      if (document.hidden && !this.running && !this._needDraw) return;   // 后台且闲着：别白烧 CPU
      if (this._needDraw || this.running){
        this._needDraw = false;
        this.drawFrame();
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  drawFrame(){
    // 跟随模式：数据在长，视图自动保持"全览"（用户一缩放/拖动就退出跟随）
    if (this.follow && this.store?.count) this.renderer.fitAll();
    const usedLod = this.renderer.draw();
    this.usedLod = usedLod;
    const st = this.store;
    const rate = st?.rate() || 0;
    $('sc-samples').textContent = String(st?.count || 0);
    $('sc-rate').textContent = rate ? `${(rate / 1000).toFixed(2)} kHz` : '0 Hz';
    $('sc-packets').textContent = String(this.packets);
    // 🚨 三种"丢"要**分开显示**：探针跳拍是探针 CPU 的账，USB 是主机排空的账，缺口是链路层
    const lostProbe = (this.probeDropped || 0) + (this.probeYield || 0);
    const lostUsb = this.usbDrop || 0;
    $('sc-lost').textContent = String(lostProbe);
    $('sc-lostusb').textContent = String(lostUsb);
    $('sc-gap').textContent = String(this.lost + (st?.overrun || 0));
    $('sc-buf').textContent = st ? `${Math.round(st.count / st.capacity * 100)}%` : '0%';
    $('sc-mem').textContent = st ? fmtBytes(st.bytes()) : '0 B';
    $('sc-mhz').textContent = this.swdMhz ? `${this.swdMhz} MHz` : '—';
    const err = $('sc-err');
    if (err){
      err.textContent = this.planMismatch ? `⚠ ${this.planMismatch}`
        : (this.stream.resyncs ? `重同步 ${this.stream.resyncs} 次 / 垃圾 ${this.stream.junk} B` : '');
    }
    const perCol = this.renderer.span / Math.max(2, this.renderer.plotW);
    const ct = this.renderer.cursorTime();
    const dl = this.renderer.delta();
    $('sc-window').textContent = st?.count
      // 最要紧的 Δt / 频率放**最前面**：这行右边可能被省略号截掉（见 app.css 里 #sc-window 的注释）
      ? (dl ? `Δt ${fmtTime(dl.absUs)}${dl.dtUs < 0 ? '（B 在前）' : ''} · ${fmtHz(dl.hz)}` +
              `（A ${fmtTime(dl.a.relUs)} → B ${fmtTime(dl.b.relUs)} · ${dl.samples} 样本） · `
            : (ct ? `游标 t=${ct.text}（#${ct.index}） · ` : '')) +
        `${fmtTime(st.timeAt(Math.max(0, Math.ceil(this.renderer.view.end) - 1)) - st.timeAt(Math.floor(this.renderer.view.start)))} 窗口 · ` +
        `每列 ${perCol.toFixed(1)} 样本 ${usedLod ? '(LOD)' : '(精确)'}` +
        (perCol < 1.5 ? ' · 连点折线' : ' · 包络带（点「细看」看波形形状）') +
        (this.follow ? ' · 跟随最新' : '')
      : '';
    this.renderLegend();
    if (st?.full && this.running) this.setStatusText('缓冲已满：采样自动停止（要更长时间就把「时长」调大）', 'warn');
  }

  renderLegend(){
    const box = $('sc-legend');
    if (!box || !this.store) return;
    // 游标可能来自"窗口尺寸变了"之前的旧位置 —— 夹到有效范围，别显示一个不存在的样本号
    const cur = this.renderer.cursor != null ? Math.min(this.renderer.cursor, this.store.count - 1) : null;
    const rows = legendRows(this.store, cur, this.renderer.hidden);
    // 游标时刻统一显示在画布下的标签和状态行里（每行都挂一遍太吵），这里只留 tooltip 带样本号
    const ct = this.renderer.cursorTime();
    const tip = ct ? ` title="t=${ct.text}（相对采集起点）· 样本 #${ct.index}"` : '';
    box.innerHTML = rows.map(r =>
      `<span class="lrow${r.visible ? '' : ' off'}" data-k="${r.index}"${tip}>` +
      `<i class="dot" style="background:${r.color}"></i>${r.name}` +
      `<span class="lv">${fmtVal(r.value)}${ct ? ' @' + ct.text : ''}</span></span>`).join('');
    for (const el of box.querySelectorAll('.lrow')){
      el.addEventListener('click', () => {
        const k = Number(el.dataset.k);
        this.renderer.setVisible(k, !this.renderer.isVisible(k));
        this._needDraw = true;
      });
    }
  }

  // ================================================================= 自检摘要
  summary(){
    const st = this.store;
    return {
      state: this.state,
      mode: this.usingMock ? 'mock' : 'real',
      elf: this.elf,
      vars: (this.selected.length ? this.selected : []).map(v => `${v.name}:${v.scalar}@0x${v.addr.toString(16)}`),
      varCount: this.selected.length,
      plan: this.plan ? { spans: this.plan.spans.length, frameBytes: this.plan.frameBytes,
                          estUs: +this.plan.estUs.toFixed(2), estHz: this.plan.estHz } : null,
      samples: st?.count || 0,
      capacity: st?.capacity || 0,
      packets: this.packets,
      lost: this.lost + (this.probeDropped || 0) + (st?.overrun || 0),
      lostProbe: this.probeDropped || 0,          // 探针跳拍（探针 CPU 的账）
      lostUsb: this.usbDrop || 0,                 // 无缓冲丢样本（主机排空的账）
      lostGap: this.lost + (st?.overrun || 0),    // seq 缺口 + 缓冲溢出
      benchUs: this.benchUs || null,
      blob: this.blob || null,
      connectErr: this.connectErr || null,
      rateHz: Math.round(st?.rate() || 0),
      trigger: { mode: this.trigger.mode, hit: this.trigger.hitIndex, hits: this.trigger.hits,
                 marker: !!this.renderer.trigger },
      view: { start: Math.round(this.renderer.view.start), end: Math.round(this.renderer.view.end) },
      lod: !!this.usedLod,
      resyncs: this.stream.resyncs,
      raw: this.raw.length,
      running: this.running,
      mockVars: this.mockVars().map(v => v.name),
    };
  }
}

function numToCsv(v){
  if (Number.isInteger(v)) return String(v);
  if (!Number.isFinite(v)) return '';
  return v.toPrecision(9).replace(/0+$/, '').replace(/\.$/, '');
}
