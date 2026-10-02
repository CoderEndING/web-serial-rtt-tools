/**
 * 「寄存器」面板（`#i2c` 页的第 3 个 dock tab）——**读一段 → 逐位改 → 写回**。
 *
 * 为什么要有它：调试 I2C 器件时 90% 的动作是"把某个寄存器的某一位打开/关掉，看看效果"。
 * 命令表/脚本能做，但每一步都要人肉把 `0x55` 拆成 8 个位、数第几位、再手拼十六进制 ——
 * 这里把这套动作压成：**读一次（默认 128 B）→ 表里点字节 → 点那一位 → 只写改动**。
 * 交互形态照 `#panel` 页的「面板初始化」字节开关板（用户 2026-10-03 指定参考），
 * 连 CSS（`.bitpop` 那套 47px 大方块 + 黄框标改动）都是复用的。
 *
 * 三条语义纪律：
 *   1. **改的是内存里这份缓冲（`cur`），不碰器件**；只有点「只写改动 / 整块写回」才发 I2C。
 *   2. `base` 是"读回来的原值"，**写回成功后才更新** —— 黄框标的就是"与器件现状不同的字节"。
 *   3. 长读分片走 `session.readLong`、长写分片走 `session.writeLong`（协议层的 planRead/planWrite），
 *      页面里**不自己切片** —— 54 B / 51 B 这类限制只该有一处知识。
 */
import { $ } from '../ui/dom.js';
import { store } from '../core/store.js';
import * as P from './protocol.js';
import * as R from './registers.js';

const h2 = v => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');

/**
 * 字节的位开关板（8 个大方块 + 一排快捷键）——复用 `#i2c` 自己的 `.bitpop` 实例
 * （和 `#panel` 页那块 `.bitpop` 共用 CSS，不共用 DOM：两页各一份，谁也不挡谁）。
 */
class ByteBitPop {
  constructor({ onEdit } = {}){
    this.onEdit = onEdit || null;
    this.cellOff = null;
    this.anchor = null;
    this._key = e => { if (e.key === 'Escape') this.close(); };
    this._follow = () => { if (this.isOpen) this.reposition(); };
  }
  get isOpen(){ return this.cellOff != null; }
  /** 当前正在编辑的字节值由外部给（RegView 是唯一事实源）*/
  values = { get: () => 0, orig: () => null };

  init(){
    const el = $('i2-regpop');
    if (!el) return;
    $('i2-regpop-bits').addEventListener('click', e => {
      const b = e.target.closest('button.bit');
      if (b && this.isOpen) this.onEdit?.(this.cellOff, R.toggleBit(this.values.get(), +b.dataset.k));
    });
    el.addEventListener('click', e => {
      const btn = e.target.closest('button[data-bit]');
      if (!btn || !this.isOpen) return;
      const act = btn.dataset.bit;
      const v = this.values.get();
      if (act === 'zero') this.onEdit?.(this.cellOff, 0x00);
      else if (act === 'ones') this.onEdit?.(this.cellOff, 0xff);
      else if (act === 'inv') this.onEdit?.(this.cellOff, ~v & 0xff);
      else if (act === 'orig') this.onEdit?.(this.cellOff, this.values.orig() ?? v);
      else if (act === 'close') this.close();
    });
    // 手打十六进制：与点 bit 走**同一条路**（两边同步，和 #panel 页一致）
    $('i2-regpop-hex').addEventListener('input', e => {
      if (!this.isOpen) return;
      const t = e.target.value.trim().replace(/^0[xX]/, '');
      if (!/^[0-9a-fA-F]{1,2}$/.test(t)){ e.target.classList.add('bad'); return; }
      e.target.classList.remove('bad');
      this.onEdit?.(this.cellOff, parseInt(t, 16));
    });
    $('i2-regpop-hex').addEventListener('keydown', e => { if (e.key === 'Enter') this.close(); });
    document.addEventListener('pointerdown', e => {
      if (!this.isOpen) return;
      const el2 = $('i2-regpop');
      if (el2?.contains(e.target) || e.target.closest?.('button.rb')) return;   // 点另一个字节 = 换一格
      this.close();
    }, true);
    document.addEventListener('keydown', this._key);
    window.addEventListener('scroll', this._follow, { passive: true, capture: true });
    window.addEventListener('resize', this._follow, { passive: true });
  }

  open({ off, anchor }){
    const el = $('i2-regpop');
    if (!el || !anchor) return;
    this.cellOff = off;
    this.anchor = anchor;
    el.hidden = false;
    this.render();
    this.reposition();
  }
  close(){
    if (!this.isOpen) return;
    this.cellOff = null;
    this.anchor = null;
    const el = $('i2-regpop');
    if (el) el.hidden = true;
  }
  /** 表格重绘后锚点会换 DOM 节点 → 按 offset 找回来*/
  reattach(){
    if (!this.isOpen) return;
    const el = document.querySelector(`#i2-reg-body button.rb[data-off="${this.cellOff}"]`);
    if (el) this.anchor = el; else this.close();
  }
  reposition(){
    if (!this.isOpen) return;
    const el = $('i2-regpop');
    if (!this.anchor?.isConnected){ this.close(); return; }
    const r = this.anchor.getBoundingClientRect();
    const left = Math.min(Math.max(6, r.left - 40), window.innerWidth - el.offsetWidth - 8);
    let top = r.bottom + 6;
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 6);
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }
  render(){
    if (!this.isOpen) return;
    const v = this.values.get(), o = this.values.orig();
    $('i2-regpop-title').textContent = `偏移 ${this.label || '+' + this.cellOff}`;
    $('i2-regpop-val').textContent = `0x${h2(v)} = ${v} = 0b${R.bitsOf(v).slice().reverse().join('')}` +
      (o != null && o !== v ? `　（原 0x${h2(o)}）` : '');
    const bits = R.bitsOf(v);
    const parts = [];
    for (let k = 7; k >= 0; k--){
      const on = bits[k] ? 1 : 0;
      const was = o == null ? on : ((o >> k) & 1);
      parts.push(`<button class="bit${on ? ' on' : ''}${on !== was ? ' chg' : ''}" data-k="${k}"` +
        ` title="bit${k}（权重 ${1 << k}）—— 点一下翻转">` +
        `<span class="bk">bit${k}</span><span class="bv">${on}</span><span class="bw">${1 << k}</span></button>`);
    }
    $('i2-regpop-bits').innerHTML = parts.join('');
    const hex = $('i2-regpop-hex');
    if (document.activeElement !== hex){ hex.value = h2(v); hex.classList.remove('bad'); }
    $('i2-regpop-hint').innerHTML = '点 bit 翻转它；<span style="color:var(--warn)">黄框</span> = 与<b>读回来的原值</b>不同的位。' +
      '改完点「只写改动」把这一格（以及其它改过的格）写回器件。';
  }
}

export class RegView {
  /** @param {{session:object, onOp?:(op:object)=>void}} opts */
  constructor({ session, onOp = null } = {}){
    this.session = session;
    this.onOp = onOp;
    this.dev = 0x50;
    this.start = [0x00];
    this.addrLen = 1;
    this.len = R.REG_LEN_DFT;
    this.chunk = 'reset';
    this.wrChunk = P.WR_MAX;
    this.base = new Uint8Array(0);
    this.cur = new Uint8Array(0);
    this.busy = false;
    this.connected = false;
    this.pop = new ByteBitPop({ onEdit: (off, v) => this._onBitEdit(off, v) });
    this.pop.values = { get: () => this.cur[this.pop.cellOff] ?? 0,
                        orig: () => (this.base.length ? this.base[this.pop.cellOff] ?? null : null) };
  }

  init(){
    const ids = ['i2-reg-dev', 'i2-reg-start', 'i2-reg-len', 'i2-reg-alen', 'i2-reg-chunk', 'i2-reg-wrchunk', 'i2-reg-gap'];
    // 写分片档位（EEPROM 页写要按页给，见 registers.WRITE_CHOICES 注释）
    const wsel = $('i2-reg-wrchunk');
    for (const [v, t] of R.WRITE_CHOICES) wsel.appendChild(new Option(t, String(v)));
    // 恢复上次填的参数（调试时来回切页/刷新不该丢）
    $('i2-reg-dev').value = store.get('i2c.regDev', '0x50');
    $('i2-reg-start').value = store.get('i2c.regStart', '0x00');
    $('i2-reg-len').value = String(store.get('i2c.regLen', R.REG_LEN_DFT));
    $('i2-reg-alen').value = String(store.get('i2c.regAddrLen', 1));
    $('i2-reg-chunk').value = store.get('i2c.regChunk', 'reset');
    wsel.value = String(store.get('i2c.regWrChunk', P.WR_MAX));
    $('i2-reg-gap').value = String(store.get('i2c.regGap', 0));
    for (const id of ids) $(id).addEventListener('change', () => this._saveParams());
    // 面板上的三个动作都可能抛（输入非法、USB 掉线…）——统一兜住并写进日志，
    // 别变成"未捕获的 promise 错误"（页面自测会把它当失败，用户也看不到原因）
    const guard = fn => () => fn().catch(e => this.session.log('e', '寄存器面板：' + (e?.message || e)));
    $('i2-reg-read').addEventListener('click', guard(() => this.read()));
    $('i2-reg-write').addEventListener('click', guard(() => this.write({ only: true })));
    $('i2-reg-write-all').addEventListener('click', guard(() => this.write({ only: false })));
    $('i2-reg-discard').addEventListener('click', () => this.discard());
    $('i2-reg-body').addEventListener('click', e => {
      const b = e.target.closest('button.rb');
      if (!b) return;
      this.pop.label = b.dataset.label;
      this.pop.open({ off: +b.dataset.off, anchor: b });
    });
    $('i2-reg-dev').addEventListener('change', () => this._renderSummary());
    this.pop.init();
    this._render();
    this._renderSummary();
  }

  /** 「这份缓冲是从哪儿读来的」指纹（器件 + 起始地址 + 地址宽度）—— 写回前必须一致 */
  static keyOf(p){
    return `${p.dev}|${(p.start || []).join(',')}|${p.addrLen}`;
  }

  /** 扫描页「选用」时把器件地址带过来（省得两头填）*/
  setDevice(text){
    const el = $('i2-reg-dev');
    if (!el) return;
    el.value = text;
    this._saveParams();
    this._renderSummary();
  }

  setEnabled(on){
    this.connected = !!on;
    this._syncButtons();
  }

  _syncButtons(){
    const on = this.connected && !this.busy;
    for (const id of ['i2-reg-read', 'i2-reg-write', 'i2-reg-write-all', 'i2-reg-discard']){
      const b = $(id);
      if (b) b.disabled = !on;
    }
    const w = $('i2-reg-write');
    if (w) w.disabled = !on || !R.changedOffsets(this.base, this.cur).length;
  }

  _saveParams(){
    store.set('i2c.regDev', $('i2-reg-dev').value.trim());
    store.set('i2c.regStart', $('i2-reg-start').value.trim());
    store.set('i2c.regLen', $('i2-reg-len').value.trim());
    store.set('i2c.regAddrLen', +$('i2-reg-alen').value || 0);
    store.set('i2c.regChunk', $('i2-reg-chunk').value);
    store.set('i2c.regWrChunk', +$('i2-reg-wrchunk').value || P.WR_MAX);
    store.set('i2c.regGap', Math.max(0, +$('i2-reg-gap').value || 0));
  }

  /** 读参数（任何一项非法就抛，错误信息直接给用户看）*/
  _params(){
    const addrLen = +$('i2-reg-alen').value || 0;
    const dev = R.parseDev($('i2-reg-dev').value);
    const start = R.parseStart($('i2-reg-start').value, addrLen);
    const len = R.parseLen($('i2-reg-len').value);
    return { dev, start, addrLen, len, chunk: $('i2-reg-chunk').value === 'ptr' ? 'ptr' : 'reset',
             wrChunk: +$('i2-reg-wrchunk').value || P.WR_MAX,
             gapMs: Math.max(0, +$('i2-reg-gap').value || 0) };
  }

  async read(){
    let p;
    try { p = this._params(); }
    catch (e){ this.session.log('e', '寄存器面板：' + e.message); return; }
    this._saveParams();
    this.busy = true; this._syncButtons();
    try {
      const r = await this.session.readLong({ dev: p.dev, addr: p.start, rd: p.len, chunk: p.chunk },
        { label: `寄存器读 ${P.addr7(p.dev)}${p.addrLen ? '[' + R.addrLabel(p.start, 0, p.addrLen) + ']' : ''} × ${p.len}` });
      if (r.err !== P.E.OK){
        this.session.log('e', `寄存器读失败：${P.errText(r.err)}${r.failNote ? '（' + r.failNote + '）' : ''}`);
        return;
      }
      this.dev = p.dev; this.start = p.start; this.addrLen = p.addrLen; this.len = p.len; this.chunk = p.chunk;
      this.readKey = RegView.keyOf(p);      // 记住"这份数据是从哪儿读来的"，写回前要对账
      // 长度对不上（器件提前 NACK 停了 / 少回几个字节）就如实说，别假装读全了
      if (r.data.length !== p.len) this.session.log('w', `寄存器读：想要 ${p.len} B，只回来 ${r.data.length} B —— 表里按实际长度画`);
      const n = r.data.length || p.len;
      this.base = new Uint8Array(n);
      this.base.set(r.data);
      this.cur = this.base.slice();
      this.len = n;
      this._render();
    } finally {
      this.busy = false; this._syncButtons();
      this._renderSummary();
      this.pop.reattach();
    }
  }

  /** 写回：`only` = 只写改动字节（相邻的合并成一片）；否则整块 */
  async write({ only = true } = {}){
    if (!this.base.length){ this.session.log('w', '寄存器面板：还没读过，先「读取」再写（不然不知道器件现状）'); return; }
    let p;
    try { p = this._params(); }
    catch (e){ this.session.log('e', '寄存器面板：' + e.message); return; }
    /* 🚨 读完之后改过「器件 / 起始 / 地址宽度」就**不许写**：手里这份数据是从旧地址读回来的，
     *    照着新地址写下去 = 把一段数据糊到别的器件/别的寄存器区上（对 EEPROM 尤其致命）。
     *    要换地址就重新读一次 —— 这也是唯一能保证"黄框 = 与器件现状的差异"成立的用法。 */
    if (this.readKey && RegView.keyOf(p) !== this.readKey){
      this.session.log('e', '寄存器面板：器件/起始地址/地址宽度在「读取」之后被改过 —— 现在写回会把**旧地址读回来的数据**写到新地址上。请先重新「读取」');
      return;
    }
    const offs = only ? R.changedOffsets(this.base, this.cur) : null;
    if (only && !offs.length){ this.session.log('w', '寄存器面板：没有改动，不用写'); return; }
    const diff = R.diffBytes(this.base, this.cur);
    this.busy = true; this._syncButtons();
    try {
      const r = await this.session.writeLong(
        { dev: p.dev, addr: p.start, data: this.cur, offsets: offs, chunkMax: p.wrChunk, gapMs: p.gapMs },
        { label: `寄存器写 ${P.addr7(p.dev)}${p.addrLen ? '[' + R.addrLabel(p.start, 0, p.addrLen) + ']' : ''}` +
                 ` × ${offs ? offs.length : this.cur.length} B${offs ? '（只写改动）' : '（整块）'}` });
      if (r.err !== P.E.OK) return;
      // 写成功了 → "器件现状"就是现在这份，黄框随之清掉
      this.base = this.cur.slice();
      this._render();
      if (diff.length) this.session.log('dim', '改动已写回：' + diff.slice(0, 8).map(d =>
        `+${d.off} 0x${h2(d.from)}→0x${h2(d.to)}`).join('、') + (diff.length > 8 ? ` …共 ${diff.length} 处` : ''));
    } finally {
      this.busy = false; this._syncButtons();
      this._renderSummary();
      this.pop.reattach();
    }
  }

  /** 丢弃改动（回到读回来的那份）*/
  discard(){
    if (!this.base.length) return;
    this.cur = this.base.slice();
    this._render();
    this._renderSummary();
    this.pop.render();
  }

  _onBitEdit(off, v){
    if (!this.cur.length) return;
    const next = this.cur.slice();          // 换新数组：popover/表格都可能持有旧引用
    next[off] = v & 0xff;
    this.cur = next;
    this._paintByte(off);
    this._renderSummary();
    this.pop.render();
  }

  /** 只重画一个字节格 + 它所在行的 ASCII 列（别整表重绘：会丢滚动位置与 popover 锚点）*/
  _paintByte(off){
    const btn = document.querySelector(`#i2-reg-body button.rb[data-off="${off}"]`);
    if (!btn) return;
    const v = this.cur[off], b = this.base[off];
    btn.textContent = h2(v);
    btn.classList.toggle('chg', b != null && b !== v);
    btn.title = `偏移 +${off}（${btn.dataset.label}）· 器件现值 0x${b != null ? h2(b) : '--'}` +
                (b != null && b !== v ? ` → 改成 0x${h2(v)}` : '');
    const row = btn.closest('tr');
    const asc = row?.querySelector('td.rascii');
    if (asc){
      const first = Math.floor(off / R.REG_COLS) * R.REG_COLS;
      asc.textContent = R.asciiOf(this.cur, first, Math.min(R.REG_COLS, this.cur.length - first));
    }
  }

  _render(){
    const body = $('i2-reg-body');
    body.innerHTML = '';
    const n = this.cur.length;
    if (!n){
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="18" class="hint">还没读 —— 填好器件/起始/长度，点「读取」（默认 128 B = 16×8）</td>';
      body.appendChild(tr);
      this._syncButtons();
      return;
    }
    for (let row = 0; row < Math.ceil(n / R.REG_COLS); row++){
      const tr = document.createElement('tr');
      const first = row * R.REG_COLS;
      const td = document.createElement('td');
      td.className = 'ra';
      td.textContent = R.addrLabel(this.start, first, this.addrLen);
      tr.appendChild(td);
      for (let c = 0; c < R.REG_COLS; c++){
        const cell = document.createElement('td');
        cell.className = 'rbc';
        const off = first + c;
        if (off < n){
          const b = document.createElement('button');
          b.className = 'rb';
          b.dataset.off = String(off);
          b.dataset.label = R.addrLabel(this.start, off, this.addrLen);
          const v = this.cur[off], base = this.base[off];
          b.textContent = h2(v);
          b.classList.toggle('chg', base != null && base !== v);
          b.title = `偏移 +${off}（${b.dataset.label}）· 器件现值 0x${base != null ? h2(base) : '--'}` +
                    (base != null && base !== v ? ` → 改成 0x${h2(v)}` : '') + '　点开改 bit';
          cell.appendChild(b);
        }
        tr.appendChild(cell);
      }
      const asc = document.createElement('td');
      asc.className = 'rascii';
      asc.textContent = R.asciiOf(this.cur, first, Math.min(R.REG_COLS, n - first));
      tr.appendChild(asc);
      body.appendChild(tr);
    }
    // 表头（列号 0..15）也跟着地址宽度走，免得看串列
    const head = $('i2-reg-head');
    if (head){
      head.innerHTML = '<th class="ra">地址</th>' +
        Array.from({ length: R.REG_COLS }, (_, i) => `<th class="rh">${i.toString(16).toUpperCase()}</th>`).join('') +
        '<th class="rascii">ASCII</th>';
    }
    this._syncButtons();
  }

  _renderSummary(){
    let p = null;
    try { p = this._params(); } catch { /* 输入还没填全时只报个大概 */ }
    $('i2-reg-sum').textContent = R.summarize({
      len: p?.len ?? this.len, base: this.base, cur: this.cur,
      dev: p?.dev ?? this.dev, start: p?.start ?? this.start, addrLen: p?.addrLen ?? this.addrLen,
    });
    this._syncButtons();
  }
}
