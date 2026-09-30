/**
 * 「字节 → 位」开关板（`#pn-bitpop`）：点解析表里的任意一个字节，弹出它的 8 个 bit，
 * 勾/取消**立刻改掉那个字节**。
 *
 * 为什么要它：面板初始化命令的参数就是**寄存器值**（0x36 MADCTL、0x3A COLMOD…）。想试
 * "换个色序 / 换 16bpp / 打开某一位"时，人得先在脑子里把 0x55 换成 0101 0101 再数第几位 ——
 * 直接把 8 个位摆出来勾，比"改文本 → 重解析 → 再数位"快一个数量级（用户 2026-09-30 点名要）。
 *
 * 四条交互约定：
 *   1. **点谁改谁**：勾一个位 → `setRowByte()` 写回那一行 → 表格该行的字节立刻变（并标"·改"）；
 *   2. **不回写文本框**：改的是"这份步骤表"（重放 / 导出用它），上面贴的原文保持原样 ——
 *      再点「解析并预览」会按原文重建（这是有意的：原文是用户的资产，页面不偷偷改它）；
 *   3. 关掉的方式：× / Esc / 点别处 / 在表里点另一个字节（自动挪过去）；
 *   4. 位名只在**有把握**的命令上标（见 `panel-code.js` 的 `BIT_NAMES`），其余只给位号与位权。
 *
 * DOM 坐标用 `position:fixed`：主区（`.main`）是 `overflow:auto`，放里面会被滚动裁掉。
 */
import { $ } from '../ui/dom.js';
import { byteBits, bitsByte, toggleBit, bitsText, bitWeight, bitNamesFor, setRowByte } from './panel-code.js';

export class BitPopover {
  /**
   * @param {{onEdit?:(row:object,i:number,k:(number|'cmd'),v:number)=>void}} opts
   *        onEdit 在**每次**改动后回调（view 用它重绘表格 + 更新摘要）
   */
  constructor({ onEdit } = {}){
    this.onEdit = onEdit || null;
    this.row = null; this.index = -1; this.k = 'cmd';
    this.open_ = false;
    this._outside = e => {
      const el = $('pn-bitpop');
      if (el && !el.hidden && !el.contains(e.target) && !e.target.closest?.('#pn-code-body button.byte')) this.close();
    };
    this._key = e => { if (e.key === 'Escape') this.close(); };
  }

  get isOpen(){ return this.open_; }

  /** 当前正在编辑的字节（表格重绘后用它把高亮还回去）*/
  get target(){ return this.open_ ? { index: this.index, k: this.k } : null; }

  init(){
    const el = $('pn-bitpop');
    if (!el) return;
    $('pn-bitpop-close').addEventListener('click', () => this.close());
    $('pn-bitpop-zero').addEventListener('click', () => this.setValue(0x00));
    $('pn-bitpop-ones').addEventListener('click', () => this.setValue(0xff));
    $('pn-bitpop-inv').addEventListener('click', () => this.setValue(~this.value() & 0xff));
    $('pn-bitpop-hex').addEventListener('input', e => {
      const t = e.target.value.trim().replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,2}$/i.test(t)) return;          // 打一半（"5"）也认；非法字符就不动
      this.setValue(parseInt(t, 16), { keepHex: true });
    });
    // 位的勾选：用事件委托 —— 每次重绘都重建 label，逐个挂监听会漏
    $('pn-bitpop-bits').addEventListener('change', e => {
      const cb = e.target.closest('input[type=checkbox]');
      if (cb) this.setValue(toggleBit(this.value(), +cb.dataset.bit));
    });
  }

  /**
   * 打开（或挪到另一个字节上）。
   * @param {{row:object,index:number,k:(number|'cmd'),at:DOMRect,chip?:Element}} o
   */
  open({ row, index, k, at }){
    if (!row) return;
    this.row = row; this.index = index; this.k = k;
    this.open_ = true;
    const el = $('pn-bitpop');
    el.hidden = false;
    this.render();
    // 位置：优先贴在字节的**下面**；下面放不下就翻到上面；左右夹在视口里
    const r = el.getBoundingClientRect();
    const below = at.bottom + 6;
    const top = (below + r.height <= innerHeight - 6) ? below : Math.max(6, at.top - r.height - 6);
    el.style.top = Math.round(top) + 'px';
    el.style.left = Math.round(Math.min(Math.max(6, at.left), Math.max(6, innerWidth - r.width - 8))) + 'px';
    document.addEventListener('pointerdown', this._outside, true);
    document.addEventListener('keydown', this._key);
    this.markChip();
  }

  close(){
    if (!this.open_) return;
    this.open_ = false;
    this.row = null; this.index = -1;
    const el = $('pn-bitpop');
    if (el) el.hidden = true;
    document.removeEventListener('pointerdown', this._outside, true);
    document.removeEventListener('keydown', this._key);
    document.querySelectorAll('#pn-code-body button.byte.open').forEach(b => b.classList.remove('open'));
  }

  /** 当前字节值（弹窗没开时返回 0）*/
  value(){
    if (!this.row) return 0;
    return this.k === 'cmd' ? (this.row.cmd & 0xff) : (this.row.data[this.k] ?? 0) & 0xff;
  }

  /** 改值（唯一入口）：写回行 + 刷新弹窗 + 通知 view */
  setValue(v, { keepHex = false } = {}){
    if (!this.row) return;
    const val = v & 0xff;
    setRowByte(this.row, this.k, val);
    const { row, index, k } = this;
    this.onEdit?.(row, index, k, val);
    if (this.open_) this.render({ keepHex });        // view 重绘表格不会动这块弹窗
    this.markChip();
  }

  /** 把高亮还给（重绘后的）那个字节按钮 */
  markChip(){
    if (!this.open_) return;
    document.querySelectorAll('#pn-code-body button.byte.open').forEach(b => b.classList.remove('open'));
    const sel = `#pn-code-body button.byte[data-i="${this.index}"][data-k="${this.k}"]`;
    document.querySelector(sel)?.classList.add('open');
  }

  render({ keepHex = false } = {}){
    if (!this.row) return;
    const val = this.value();
    const bits = byteBits(val);
    const info = bitNamesFor(this.row.cmd);
    const what = this.k === 'cmd' ? '命令' : `参数[${this.k}]`;
    $('pn-bitpop-title').textContent = `#${this.index} · ${what} · 0x${val.toString(16).toUpperCase().padStart(2, '0')}`;
    // 位从高到低排（bit7 左上 → bit0 右下），和"写二进制"的习惯一致
    $('pn-bitpop-bits').innerHTML = [7, 6, 5, 4, 3, 2, 1, 0].map(b => {
      const nm = info?.bits?.[b] || '';
      return `<label class="${bits[b] ? 'on' : ''}" title="bit${b} · 位权 ${bitWeight(b)}">
        <input type="checkbox" data-bit="${b}"${bits[b] ? ' checked' : ''}>bit${b}
        <span class="w">${bitWeight(b)}</span><span class="nm">${nm}</span></label>`;
    }).join('');
    if (!keepHex) $('pn-bitpop-hex').value = '0x' + val.toString(16).toUpperCase().padStart(2, '0');
    $('pn-bitpop-bin').textContent = bitsText(val).replace(/(.{4})(.{4})/, '$1 $2');
    const rowNote = this.k === 'cmd'
      ? '改的是命令字节（0x36 MADCTL / 0x3A COLMOD 这类），重放时它就是 DCS 命令。'
      : `改的是参数字节 ${this.k}：重放 / 导出用改后的值，上面文本框里的原文不动。`;
    $('pn-bitpop-note').textContent = (info ? `${info.name}。${info.note} ` : '这个命令没有内置位名（只给位号与位权）。') + rowNote;
  }
}
