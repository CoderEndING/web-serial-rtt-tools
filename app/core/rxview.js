/**
 * 接收缓冲区：raw 记录（供切换显示模式/保存用）+ 增量 DOM 文本节点（供显示）。
 *
 * 设计要点（都是踩过的坑）：
 *  ① 每来一段就 append 一个文本节点，别整块 textContent 重写 —— 串口日志刷得快时
 *     整块重写会让页面卡住；裁掉旧数据时删掉最老的节点即可。
 *  ② raw 记录有上限（默认 2MB / 4000 行），超了从头丢并置 truncated 标记，
 *     否则长时间挂机把内存吃光。
 *  ③ 切换 ASCII/HEX、开关时间戳 → repaint() 从 raw 重建（不是从显示文本反推）。
 *  ④ 暂停 = 只停止重绘，数据照收；继续时一次性重建，不丢数据。
 */
import { bytesToHexView, bytesToText } from './hex.js';
import { stamp as stampOf } from './format.js';

const countNl = s => { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; };

export class RxBuffer {
  constructor(el, opts = {}){
    this.el = el;
    this.maxLines = opts.maxLines ?? 4000;
    this.maxRaw = opts.maxRaw ?? 2 * 1024 * 1024;
    this.mode = opts.mode || 'ascii';      // ascii | hex
    this.timestamps = false;
    this.absolute = false;
    this.autoscroll = true;
    this.paused = false;
    this.truncated = false;
    this.raw = [];                         // [{t, b}]
    this.rawBytes = 0;
    this.nodes = [];                       // [{node, lines}]
    this.lines = 0;
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.onChange = null;                  // 外部（统计条）用的钩子
  }

  // ---------------- 设置 ----------------
  setMode(m){ if (this.mode === m) return; this.mode = m; this.repaint(); }
  setTimestamps(on, absolute = this.absolute){
    if (this.timestamps === on && this.absolute === absolute) return;
    this.timestamps = on; this.absolute = absolute; this.repaint();
  }
  setAutoscroll(on){ this.autoscroll = on; if (on) this._scroll(); }
  setPaused(on){
    if (this.paused === on) return;
    this.paused = on;
    if (!on) this.repaint();
  }

  // ---------------- 数据 ----------------
  /** @param {Uint8Array} bytes */
  push(bytes, t = new Date(), prefix = ''){
    if (!bytes || !bytes.length) return;
    this._store(bytes, t);
    if (!this.paused) this._append(this.format(bytes, t, prefix));
  }

  _store(b, t){
    this.raw.push({ t, b });
    this.rawBytes += b.length;
    while (this.rawBytes > this.maxRaw && this.raw.length > 1){
      this.rawBytes -= this.raw.shift().b.length;
      this.truncated = true;
    }
  }

  /** 一段字节 → 显示文本 */
  format(b, t, prefix = ''){
    const ts = this.timestamps ? `[${stampOf(t, this.absolute)}] ` : '';
    let body;
    if (this.mode === 'hex') body = bytesToHexView(b);
    else body = bytesToText(b, this.decoder);       // 流式解码：跨包的多字节字符不会被拆坏
    if (prefix){
      // 回显/标记行：单独一行，不与数据混在一起
      return `${ts}${prefix}${this.mode === 'hex' ? bytesToHexView(b).trim() : body.replace(/[\r\n]+$/, '')}\n`;
    }
    if (!body) return '';
    if (ts) body = body.split('\n').map((l, i, a) => (i === a.length - 1 && l === '') ? '' : ts + l).join('\n');
    return body;
  }

  /** 把一串记录当成一个整体渲染（保存文件用；解码器状态跨记录连续） */
  render(records){
    const saved = this.decoder;
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    let s = '';
    for (const r of records || this.raw) s += this.format(r.b, r.t);
    this.decoder = saved;
    return s;
  }

  _append(text){
    if (!text) return;
    const node = document.createTextNode(text);
    this.el.appendChild(node);
    const ln = countNl(text);
    this.nodes.push({ node, ln });
    this.lines += ln;
    while (this.lines > this.maxLines && this.nodes.length > 1){
      const f = this.nodes.shift();
      this.lines -= f.ln;
      f.node.remove();
    }
    if (this.autoscroll) this._scroll();
  }

  _scroll(){ this.el.scrollTop = this.el.scrollHeight; }

  /** 整块重建（切模式、开关时间戳、暂停恢复、清空后回填） */
  repaint(){
    for (const { node } of this.nodes) node.remove();
    this.nodes = []; this.lines = 0;
    this.el.textContent = '';
    if (this.truncated) this._append('（较早的数据已因超出上限被丢弃）\n');
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    for (const { t, b } of this.raw) this._append(this.format(b, t));
    this._scroll();
  }

  clear(){
    this.raw = []; this.rawBytes = 0; this.truncated = false;
    for (const { node } of this.nodes) node.remove();
    this.nodes = []; this.lines = 0;
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.el.textContent = '';
  }

  /** 导出文本（保存文件用）：按当前模式 + 时间戳设置 */
  text(){
    let s = this.truncated ? '（较早的数据已因超出上限被丢弃）\n' : '';
    return s + this.render(this.raw);
  }

  get bytes(){ return this.rawBytes; }
  get empty(){ return !this.raw.length; }
}
