/**
 * 「调试器」页（#dbg）—— 零安装的极简调试前端：暂停/继续/单步/复位、寄存器、内存、
 * 硬件断点、命令行（gdb 风格的最小子集）、RTT 输出同屏。
 *
 * 分工：**这个文件只管 DOM**，所有语义都在
 *   app/dbg/session.js（会话：运行控制 / 寄存器 / 内存 / FPB 断点）
 *   app/dbg/cmd.js    （命令解析与输出，纯逻辑）
 *   app/dbg/symbols.js（ELF 符号）
 * 里，它们都能在没有浏览器的情况下自测。
 *
 * 三条本仓的界面纪律：
 *   ① 短等待一律用 core/pace.js 的 waitMs（页面在后台时 setTimeout 会被钳到 ≥1 s）；
 *   ② 日志/表格的滚动用 ui/dom.js 的 appendLogLine（别每行写 scrollTop：读 scrollHeight 会强制同步布局）；
 *   ③ 新加的元素一律 `if (el)` 判空 —— 旧 index.html + 新 js（或反过来）时不能让初始化整个断掉。
 */

import { $, setFlag, appendLogLine } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { waitMs } from '../core/pace.js';
import { DebugSession, DEFAULT_CLOCK_KHZ } from './session.js';
import { runCmd } from './cmd.js';
import { SymTab } from './symbols.js';
import { hex32, parseBytes } from './fmt.js';
import { Rtt } from '../rtt/protocol.js';

const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); return el; };

export class DbgView {
  constructor(){
    this.session = new DebugSession();
    this.bus = null;                       // ProbeBus（由 main.js 注入，用来请别的页签让出探针）
    this.sym = null;
    this.rtt = null;
    this.elfName = '';
    this.mem = new Uint8Array(0);
    this.memAddr = 0;
    this.sel = new Map();                  // 寄存器名 → 待提交的编辑（input 的临时值）
    this.hist = [];
    this.histIdx = -1;
    this.watching = false;
    this.rttTimer = null;
    this.autoRead = true;
  }

  // ================================================================ 初始化

  init(){
    const s = this.session;
    s.log = (t, c) => this._out(t, c);
    s.sym = null;

    // ---- 侧栏 ----
    const be = $('d-backend');
    if (be){ store.bind(be, 'dbg.backend'); be.addEventListener('change', () => this._syncBackend()); }
    const clk = $('d-clock');
    if (clk){ store.bind(clk, 'dbg.clock'); clk.value = clk.value || String(DEFAULT_CLOCK_KHZ); }
    on('d-connect', 'click', () => this.connect());
    on('d-disconnect', 'click', () => this.disconnect());
    on('d-elf-pick', 'click', () => $('d-elf-file')?.click());
    on('d-elf-file', 'change', e => this._loadElfFile(e.target.files?.[0]));
    on('d-reset-halt', 'click', () => this._act('复位并停住', async () => { await s.resetHalt(); await this.refreshAll(); }));
    on('d-reset-run', 'click', () => this._act('复位并运行', async () => { await s.resetRun(); this._startWatch(); }));
    on('d-reg-refresh', 'click', () => this._act('刷新寄存器', () => s.refreshRegs().then(() => this.renderRegs())));
    on('d-bp-clear', 'click', () => this._act('清空断点', async () => { await s.bpClear(); this.renderBps(); }));
    on('d-rtt-locate', 'click', () => this.rttStart());
    on('d-rtt-stop', 'click', () => this.rttStop());
    const rttChk = $('d-rtt-on');
    if (rttChk) store.bind(rttChk, 'dbg.rttAuto', 'checked');
    const ra = $('d-rtt-addr');
    if (ra) store.bind(ra, 'dbg.rttAddr');

    // ---- 主区按钮 ----
    on('d-halt', 'click', () => this._act('暂停', async () => { await s.halt(); this.renderRegs(); this.renderMem(); }));
    on('d-cont', 'click', () => this._act('继续', async () => { await s.cont(); this._startWatch(); }));
    on('d-step', 'click', () => this._act('单步', async () => { await s.step(); this.renderRegs(); this.renderMem(); }));
    on('d-mem-read', 'click', () => this._act('读内存', () => this.readMem()));
    // 🚨 writeMemEdit() **自己**已经包了 _act —— 这里再包一层会让内层看到 busy=true 直接退出，
    //    现象是"点了写入、日志只说正在忙、内存一个字节都没改"（本仓自测抓到的）
    on('d-mem-write', 'click', () => this.writeMemEdit());
    on('d-run', 'click', () => this.runLine($('d-cmd')?.value));
    const cmd = $('d-cmd');
    if (cmd){
      cmd.addEventListener('keydown', e => {
        if (e.key === 'Enter'){ e.preventDefault(); this.runLine(cmd.value); cmd.value = ''; }
        else if (e.key === 'ArrowUp'){ e.preventDefault(); this._hist(-1); }
        else if (e.key === 'ArrowDown'){ e.preventDefault(); this._hist(1); }
      });
    }
    const ev = $('d-mem-ev');
    if (ev) ev.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); this.writeMemEdit(); } });
    // 手改了「改」那一行的地址，就别再用"点字节"记下的那个地址
    const ea = $('d-mem-ea');
    if (ea) ea.addEventListener('input', () => { this._memEditAddr = null; });
    const ma = $('d-mem-addr');
    if (ma){
      store.bind(ma, 'dbg.memAddr');
      ma.addEventListener('input', () => { this._memEditAddr = null; });      // 手改了地址就别再用"点字节"记下的那个
      ma.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); this.readMem(); } });
    }
    const ml = $('d-mem-len');
    if (ml) store.bind(ml, 'dbg.memLen');
    const fp = $('d-follow-pc');
    if (fp) store.bind(fp, 'dbg.followPc', 'checked');
    const mw = $('d-mem-write-on');
    if (mw){ store.bind(mw, 'dbg.memWritable', 'checked'); mw.addEventListener('change', () => this.renderMem()); }

    this._syncBackend();
    this._syncButtons(false);
    // 先把三个空面板的占位提示画出来（否则刚打开是一片空白，看着像坏了）
    this.renderRegs(); this.renderMem(); this.renderBps();
    if (!DbgView.supported()) this._out('这个浏览器没有 WebUSB（桌面版 Chrome/Edge 才有）—— 可以选「模拟目标」体验界面', 'warn');
    this._out('调试器就绪。连上目标后按 h 看命令，或用上面的大按钮。', 'dim');
    return this;
  }

  static supported(){ return typeof navigator !== 'undefined' && 'usb' in navigator; }

  onShow(){
    // 切回本页时对账一次状态（目标可能在别的页签里被复位/被烧录器抢走）
    if (this.session.connected) this.refreshAll().catch(() => {});
  }

  _syncBackend(){
    const mock = ($('d-backend')?.value || 'webusb') === 'mock';
    const clk = $('d-clock');
    if (clk) clk.disabled = mock;
    const hint = $('d-elf-info');
    if (hint && !this.sym) hint.textContent = mock
      ? '模拟目标也有自己的内存/寄存器，可以配合载入 .elf 练手（断点、单步、p 变量都能跑）。'
      : '载入 .elf 后可用符号名下断点、`p 变量` 看数值、PC 显示函数名。';
  }

  _syncButtons(connected, halted){
    const c = connected ?? this.session.connected;
    const h = halted ?? this.session.halted;
    for (const id of ['d-cont', 'd-step', 'd-halt', 'd-mem-read']){
      const el = $(id);
      if (el) el.disabled = !c;
    }
    const step = $('d-step');
    if (step) step.disabled = !c || !h;            // 运行中不能单步
    const haltBtn = $('d-halt');
    if (haltBtn) haltBtn.disabled = !c || h;
    const cont = $('d-cont');
    if (cont) cont.disabled = !c || !h;
    for (const id of ['d-connect']) { const el = $(id); if (el) el.disabled = c; }
    for (const id of ['d-disconnect', 'd-reset-halt', 'd-reset-run', 'd-rtt-locate']){ const el = $(id); if (el) el.disabled = !c; }
    setFlag($('d-state'), !c ? '未连接' : (h ? '已停止' : '运行中'), !c ? null : (h ? 'warn' : 'on'));
  }

  // ================================================================ 连接

  async connect(){
    const mock = ($('d-backend')?.value || 'webusb') === 'mock';
    const clockKhz = Number($('d-clock')?.value) || DEFAULT_CLOCK_KHZ;
    this._out('', 'dim');
    this._out(`──── 连接（${mock ? '模拟目标' : 'WebUSB'}${mock ? '' : ` · ${clockKhz} kHz`}）────`, 'dim');
    try {
      await this.session.connect({ mock, clockKhz, bus: this.bus });
    } catch (e){
      this._out('✗ 连接失败：' + (e?.message || e), 'err');
      toast('连接失败：' + (e?.message || e), 'err', 7000);
      return false;
    }
    await this.refreshAll();
    this._syncButtons(true);
    this.renderBps();
    this._out(`目标${this.session.halted ? '处于**停止**状态' : '**正在运行**'}`, 'dim');
    if (this.session.halted) await this._followPc();
    if ($('d-rtt-on')?.checked) this.rttStart().catch(() => {});
    else if (!this.session.halted) this._startWatch();
    return true;
  }

  async disconnect(){
    this._stopWatch();
    this.rttStop();
    await this.session.disconnect();
    // 符号表**故意留着**：断开往往只是为了让别的页签用探针，重连后还得接着看变量
    this.mem = new Uint8Array(0);
    this.renderRegs(); this.renderMem(); this.renderBps();
    this._syncButtons(false);
    const info = $('d-elf-info');
    if (info && this.sym) info.textContent = `已断开（符号表还在：${this.sym.summary()}）`;
    else if (info) info.textContent = '已断开。';
  }

  /** 一次用户动作的统一包装：忙碌标记 + 错误回显（别让异常静默消失） */
  async _act(name, fn){
    if (this.session.busy){ this._out(`（正在忙，先等上一个动作跑完）`, 'warn'); return false; }
    this.session.busy = true;
    try { await fn(); return true; }
    catch (e){
      this._out(`✗ ${name}失败：${e?.message || e}`, 'err');
      toast(`${name}失败：${e?.message || e}`, 'err', 6000);
      return false;
    } finally {
      this.session.busy = false;
      this._syncButtons();
    }
  }

  // ================================================================ 刷新显示

  async refreshAll(){
    await this.session.refresh();
    if (this.session.halted) await this.session.refreshRegs();
    this.renderRegs();
    await this.readMem({ silent: true });
    this.renderBps();
    this._syncButtons(true);
    const cap = $('d-bp-cap');
    if (cap) cap.textContent = this.session.bpCapacity
      ? `硬件断点上限 ${this.session.bpCapacity} 个（FPB rev${this.session.caps.rev}）—— 命令 b <地址|符号> 添加，点列表里的 × 删除`
      : '这颗内核没报告可用的 FPB 比较器（读 FP_CTRL 说 0 个）';
    return true;
  }

  renderRegs(){
    const box = $('d-regs');
    if (!box) return;
    const list = this.session.regList();
    if (!list.length){
      box.textContent = '';
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = this.session.connected ? '（还没有读到寄存器）' : '（未连接）';
      box.appendChild(d);
      return;
    }
    // 行数固定 = 21：复用已有节点，避免每次刷新重建 DOM（也保住用户正在编辑的输入框）
    if (box.children.length !== list.length || box.dataset.built !== '1'){
      box.textContent = '';
      box.dataset.built = '1';
      for (const r of list){
        const row = document.createElement('div');
        row.className = 'regrow';
        const nm = document.createElement('span'); nm.className = 'rn'; nm.textContent = r.name;
        const inp = document.createElement('input'); inp.className = 'rv mono'; inp.spellcheck = false;
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter'){ e.preventDefault(); this._writeRegInput(r.name, inp); }
          else if (e.key === 'Escape'){ e.preventDefault(); inp.value = this._regText(r.name); inp.blur(); }
        });
        const note = document.createElement('span'); note.className = 'note';
        row.append(nm, inp, note);
        box.appendChild(row);
      }
    }
    list.forEach((r, i) => {
      const row = box.children[i];
      if (!row) return;
      const inp = row.querySelector('input');
      const note = row.querySelector('.note');
      if (inp && document.activeElement !== inp) inp.value = hex32(r.value);
      row.classList.toggle('chg', !!r.changed);
      if (note){
        let extra = '';
        if (r.name === 'PC' || r.name === 'LR'){
          const f = this.sym?.funcAt?.(r.value & ~1);
          if (f) extra = `→ ${f.name}+0x${f.off.toString(16)}${f.exact ? '' : '(?)'}`;
          else if (r.value >= 0x1fff0000 && r.value < 0x20000000) extra = '⚠ ROM bootloader';
        } else if (r.name === 'XPSR') extra = this._xpsrText(r.value);
        else if (r.kind === 'cfbp' && r.name === 'CONTROL') extra = (r.value & 1) ? '非特权' : '特权';
        else if (r.kind === 'cfbp' && r.name === 'BASEPRI' && r.value) extra = `≥${r.value >> 4}`;
        note.textContent = extra;
      }
      row.title = r.note || '';
    });
    const pcRow = $('d-pc');
    if (pcRow){
      const pc = list.find(r => r.name === 'PC')?.value || 0;
      const f = this.sym?.funcAt?.(pc & ~1);
      pcRow.textContent = `PC ${hex32(pc)}${f ? ' ' + f.name + '+0x' + f.off.toString(16) : ''}`;
    }
  }

  _xpsrText(v){
    const n = (v >>> 31) & 1, z = (v >>> 30) & 1, c = (v >>> 29) & 1, vf = (v >>> 28) & 1, q = (v >>> 27) & 1;
    const isr = v & 0x1ff;
    return `N${n} Z${z} C${c} V${vf} Q${q} ${isr ? 'Handler#' + isr : 'Thread'}`;
  }

  _regText(name){
    const r = this.session.regList().find(x => x.name === name);
    return hex32(r?.value || 0);
  }

  async _writeRegInput(name, inp){
    const v = parseNumSafe(inp.value);
    if (v === null){ this._out(`✗ 认不出数值：「${inp.value}」`, 'err'); inp.value = this._regText(name); return; }
    await this._act(`写 ${name}`, async () => {
      await this.session.writeReg(name, v);
      await this.session.refreshRegs();
      this.renderRegs();
      this._out(`${name} ← ${hex32(v)}`, 'ok');
      if (name === 'PC') await this._followPc();
    });
  }

  renderBps(){
    const box = $('d-bp-list');
    if (!box) return;
    box.textContent = '';
    const list = this.session.bpList();
    if (!list.length){
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = '还没有断点（命令 b main / b 0x08000123）';
      box.appendChild(d);
      return;
    }
    list.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'bprow';
      const t = document.createElement('span');
      t.className = 'mono';
      t.textContent = `#${i + 1} ${hex32(b.addr)}${b.sym ? ' ' + b.sym : ''}`;
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = '删掉这个断点';
      del.addEventListener('click', () => this._act('删断点', async () => { await this.session.bpDel(b.addr); this.renderBps(); }));
      row.append(t, del);
      box.appendChild(row);
    });
  }

  // ================================================================ 内存

  async readMem({ silent = false } = {}){
    const addr = parseNumSafe($('d-mem-addr')?.value) ?? 0;
    let len = parseNumSafe($('d-mem-len')?.value) ?? 128;
    if (len < 1) len = 1;
    if (len > 1024) len = 1024;
    this.memAddr = addr >>> 0;
    if (!this.session.connected){
      this.mem = new Uint8Array(0);
      this.renderMem('未连接');
      return false;
    }
    try {
      this.mem = await this.session.memRead(this.memAddr, len);
      this.renderMem();
      return true;
    } catch (e){
      this.mem = new Uint8Array(0);
      this.renderMem('读失败：' + (e?.message || e));
      if (!silent) this._out('✗ 读内存失败：' + (e?.message || e), 'err');
      return false;
    }
  }

  renderMem(errText){
    const box = $('d-mem');
    if (!box) return;
    box.textContent = '';
    if (errText || !this.mem.length){
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = errText || '（没有数据：点「读」）';
      box.appendChild(d);
      return;
    }
    const writable = !!$('d-mem-write-on')?.checked;
    const width = 16;
    for (let i = 0; i < this.mem.length; i += width){
      const row = document.createElement('div');
      row.className = 'hxrow';
      const a = document.createElement('span');
      a.className = 'hxa';
      a.textContent = hex32((this.memAddr + i) >>> 0);
      row.appendChild(a);
      for (let k = 0; k < width; k++){
        const idx = i + k;
        const cell = document.createElement('span');
        cell.className = 'by' + (writable ? ' w' : '');
        if (idx < this.mem.length){
          cell.textContent = this.mem[idx].toString(16).padStart(2, '0');
          cell.dataset.a = String((this.memAddr + idx) >>> 0);
          if (writable) cell.addEventListener('click', () => this._pickByte(cell.dataset.a, cell.textContent));
        } else cell.textContent = '  ';
        if (k === width / 2 - 1) row.appendChild(sep());
        row.appendChild(cell);
      }
      const asc = document.createElement('span');
      asc.className = 'asc';
      let t = '';
      for (let k = 0; k < width && i + k < this.mem.length; k++){
        const b = this.mem[i + k];
        t += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.';
      }
      asc.textContent = '|' + t + '|';
      row.appendChild(asc);
      box.appendChild(row);
    }
  }

  _pickByte(addr, val){
    const a = $('d-mem-ea'), v = $('d-mem-ev');
    if (a) a.value = '0x' + (Number(addr) >>> 0).toString(16).toUpperCase();
    if (v){ v.value = val.trim().toUpperCase(); v.focus(); v.select?.(); }
    this._memEditAddr = Number(addr) >>> 0;
  }

  async writeMemEdit(){
    const addr = this._memEditAddr ?? parseNumSafe($('d-mem-ea')?.value);
    if (addr === null || addr === undefined){ this._out('✗ 先给个地址（或点上面 dump 里的某个字节）', 'err'); return false; }
    let bytes;
    try { bytes = parseBytes($('d-mem-ev')?.value || ''); }
    catch (e){ this._out('✗ ' + e.message, 'err'); return false; }
    if (!bytes.length){ this._out('✗ 没给出要写的字节', 'err'); return false; }
    return await this._act('写内存', async () => {
      await this.session.memWrite(addr, bytes);
      const back = await this.session.memRead(addr, bytes.length);
      const same = back.length === bytes.length && back.every((b, i) => b === bytes[i]);
      this._out(`写 ${hex32(addr)} ← ${[...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ')}${same ? '（回读一致）' : '（⚠ 回读不一致）'}`, same ? 'ok' : 'err');
      await this.readMem({ silent: true });
    });
  }

  /** 内存窗口跟随 PC（在栈/在别处都能立刻看到现场） */
  async _followPc(){
    const fp = $('d-follow-pc');
    if (!fp?.checked) return;
    const pc = this.session.regList().find(r => r.name === 'PC')?.value;
    if (pc === undefined) return;
    const base = (pc & ~0xf) >>> 0;
    const ma = $('d-mem-addr');
    if (ma) ma.value = hex32(base);
    store.set('dbg.memAddr', hex32(base));          // 跟着存的也要跟着走，否则刷新后又跳回老地址
    this._memEditAddr = null;
    await this.readMem({ silent: true });
  }

  // ================================================================ 命令行

  _hist(dir){
    const cmd = $('d-cmd');
    if (!cmd || !this.hist.length) return;
    this.histIdx = dir < 0
      ? (this.histIdx < 0 ? this.hist.length - 1 : Math.max(0, this.histIdx - 1))
      : (this.histIdx < 0 ? -1 : Math.min(this.hist.length, this.histIdx + 1));
    cmd.value = this.histIdx < 0 || this.histIdx >= this.hist.length ? '' : this.hist[this.histIdx];
  }

  async runLine(text){
    const line = String(text || '').trim();
    if (!line) return { lines: [] };
    this._out('> ' + line, 'cmd');
    if (line !== this.hist[this.hist.length - 1]) this.hist.push(line);
    this.histIdx = -1;
    let res;
    try {
      res = await runCmd(line, this.session, { view: this });
    } catch (e){
      this._out('✗ ' + (e?.message || e), 'err');
      return { error: String(e?.message || e) };
    }
    if (res.clear) this._clearOut();
    for (const l of res.lines || []) this._out(l.t, l.c || '');
    // 命令可能改了状态（继续/单步/复位/断点），按结果刷新界面
    this.renderRegs(); this.renderBps(); this._syncButtons();
    const changedMem = /^(md|mw|ms|x)$/.test(line.split(/\s+/)[0].toLowerCase());
    if (changedMem) await this.readMem({ silent: true });
    if (this.session.halted) await this._followPc();
    else this._startWatch();
    return res;
  }

  _out(text, cls = ''){
    const el = $('d-out');
    if (!el) return;
    if (cls === 'cmd'){ appendLogLine(el, text, 'cmdecho', 800); return; }
    appendLogLine(el, text, cls || 'dim', 800);
  }
  _clearOut(){ const el = $('d-out'); if (el) el.textContent = ''; }

  // ================================================================ 目标在跑：轮询等它停下

  /**
   * 「继续」之后目标在跑，要等它命中/停下再刷界面。
   * 🚨 用 waitMs 而不是 setTimeout：页面不可见时短延时会被钳到 ≥1 s，
   *    150 ms 的观察间隔变成 1 s，用户看到的是"点了继续半天不更新"。
   */
  _startWatch(){
    if (this.watching) return;
    this.watching = true;
    this._watchLoop().catch(() => { this.watching = false; });
  }
  _stopWatch(){ this.watching = false; }

  async _watchLoop(){
    let polls = 0;
    while (this.watching && this.session.connected && !this.session.halted){
      await waitMs(150);
      polls++;
      try {
        await this.session.refresh();
        if (this.rtt && polls % 2 === 0) await this._rttPump();
      } catch (e){
        this._out('✗ 观察目标时出错（继续试）：' + (e?.message || e), 'err');
        await waitMs(600);
      }
      if (this.session.halted){
        await this.session.refreshRegs();
        this.renderRegs();
        const pc = this.session.pc >>> 0;
        const f = this.sym?.funcAt?.(pc & ~1);
        const atBp = this.session.bps.some(b => (b & ~1) === (pc & ~1));
        this._out(atBp
          ? `⏹ 命中断点 @ ${hex32(pc)}${f ? ' (' + f.name + '+0x' + f.off.toString(16) + ')' : ''}`
          : `⏹ 目标已停止 @ ${hex32(pc)}${f ? ' (' + f.name + '+0x' + f.off.toString(16) + ')' : ''}`, atBp ? 'ok' : 'warn');
        await this._followPc();
      }
    }
    this.watching = false;
    this._syncButtons();
  }

  // ================================================================ ELF 符号

  async _loadElfFile(file){
    if (!file) return false;
    try {
      const buf = await file.arrayBuffer();
      return this.loadElfBuffer(buf, file.name);
    } catch (e){
      this._out('✗ 读文件失败：' + (e?.message || e), 'err');
      return false;
    }
  }

  /** 供自测直接喂 ArrayBuffer（页面里也能用 fetch 拿到 fixture） */
  loadElfBuffer(buf, name = '') {
    try {
      const st = SymTab.fromBuffer(buf);
      this.sym = st;
      this.session.sym = st;
      this.elfName = name;
      const info = st.summary();
      const el = $('d-elf-info');
      if (el) el.textContent = `${name || 'ELF'}：${info}`;
      this._out(`已载入符号：${name || 'ELF'} —— ${info}`, st.note ? 'warn' : 'ok');
      this.renderRegs(); this.renderBps();
      return st;
    } catch (e){
      this._out('✗ 解析 ELF 失败：' + (e?.message || e), 'err');
      toast('解析 ELF 失败：' + (e?.message || e), 'err', 6000);
      return null;
    }
  }

  // ================================================================ RTT 同屏

  async rttStart(){
    if (!this.session.connected){ this._out('✗ 先连接目标', 'err'); return false; }
    const manual = parseNumSafe($('d-rtt-addr')?.value);
    let addr = manual;
    if (!addr){
      const v = this.sym?.find?.('_SEGGER_RTT');
      if (v?.addr) addr = v.addr;
    }
    if (!addr){
      this._out('✗ 不知道 RTT 控制块地址：载入 .elf（用 _SEGGER_RTT 符号）或在「地址」里手填', 'err');
      return false;
    }
    return await this._act('定位 RTT', async () => {
      const rtt = new Rtt(this.session.probe, { addr });
      await rtt.init(addr);
      this.rtt = rtt;
      this._out(`RTT 控制块 @ ${hex32(addr)}：上行通道 ${rtt.maxUp} 个（第 1 个 ${rtt.up[0]?.size || 0} B）、下行 ${rtt.maxDown} 个`, 'ok');
      const info = $('d-rtt-info');
      if (info) info.textContent = `已连上 @ ${hex32(addr)}`;
      await this._rttPump();
      this._startWatch();          // 跑着的时候也持续泵
    });
  }

  rttStop(){
    this.rtt = null;
    if (this.rttTimer){ clearInterval(this.rttTimer); this.rttTimer = null; }
    const info = $('d-rtt-info');
    if (info) info.textContent = '已停止。';
  }

  async _rttPump(){
    if (!this.rtt) return;
    // 🚨 readUp 返回的是 {bytes, lost, level…} 而不是 Uint8Array（这个坑写错过一次）
    const res = await this.rtt.readUp(0);
    const bytes = res?.bytes;
    if (!bytes?.length) return;
    const el = $('d-rtt');
    if (!el) return;
    el.textContent += new TextDecoder().decode(bytes);
    if (el.textContent.length > 40000) el.textContent = el.textContent.slice(-24000);
    el.scrollTop = el.scrollHeight;
  }

  // ================================================================ 自检摘要

  summary(){
    const s = this.session;
    return {
      connected: s.connected,
      backend: s.backendName,
      halted: s.halted,
      pc: s.pc >>> 0,
      clockKhz: (s.clockHz / 1000) | 0,
      regs: s.regList().length,
      bps: s.bps.map(a => hex32(a)),
      bpCap: s.bpCapacity,
      elf: this.sym ? { name: this.elfName, symbols: this.sym.size, vars: this.sym.varCount, source: this.sym.source } : null,
      rtt: this.rtt ? { addr: this.rtt.addr, maxUp: this.rtt.maxUp } : null,
      memAddr: hex32(this.memAddr),
      memLen: this.mem.length,
      watching: this.watching,
      outLines: $('d-out')?.childNodes.length || 0,
    };
  }
}

// ---------------------------------------------------------------- 小工具

function parseNumSafe(text){
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s.slice(2), 16) >>> 0;
  if (/^[0-9a-f]+h$/i.test(s)) return Number.parseInt(s.slice(0, -1), 16) >>> 0;
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10) >>> 0;
  return null;
}

function sep(){
  const s = document.createElement('span');
  s.className = 'gap';
  s.textContent = ' ';
  return s;
}
