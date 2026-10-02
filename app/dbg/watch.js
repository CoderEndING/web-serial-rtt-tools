/**
 * 「监视」窗口的纯逻辑 —— 表达式解析、取值、显示格式化。
 *
 * 为什么不写在 view.js 里：跟 `cmd.js` 一样，这些规则（认不出名字怎么办、没有类型信息时显示什么、
 * 结构体怎么摆）最容易写错，而它们**不需要浏览器也不需要硬件**，喂一个假符号表就能测到底。
 *
 * 支持的表达式（v1，够用且不含糊）：
 *   `g_var`            有 DWARF 类型 → 按类型解出数值；没有类型 → 按符号大小摆字节/字
 *   `g_var+4` `main-2` 符号加偏移（按 u32 读）
 *   `0x20000004`       直接看某个地址（按 u32 读）
 * 明确**不做**：数组下标（`a[3]`）与结构体成员（`s.x`）—— 那要完整的 DWARF 类型图，
 * 是 J-Scope / 变量浏览器那套东西的活；这里给的是"停下来瞅一眼"的最小集。
 */

import { hex32, readLE } from './fmt.js';
import { decodeScalar } from './cmd.js';
import { SCALARS } from '../elf/dwarf.js';

/** 把一行表达式解析成监视项（认不出来返回 `{expr, error}`，界面照实显示，不猜） */
export function resolveWatch(expr, sym){
  const raw = String(expr ?? '').trim();
  if (!raw) return { expr: raw, error: '空的' };
  if (!sym) return { expr: raw, error: '还没载入 .elf' };

  // 纯地址
  const direct = /^(0x[0-9a-f]+|\d+)$/i.exec(raw);
  if (direct){
    const addr = /^0x/i.test(raw) ? parseInt(raw.slice(2), 16) : parseInt(raw, 10);
    return { expr: raw, name: raw, kind: 'addr', addr: addr >>> 0, size: 4, scalar: 'u32', typeName: 'u32', label: raw };
  }

  const m = /^([A-Za-z_.$][\w.$]*)\s*([+-])\s*(0x[0-9a-f]+|\d+)$/i.exec(raw);
  const name = m ? m[1] : raw;
  const v = sym.find(name);
  if (!v) return { expr: raw, error: `找不到符号「${name}」（可用 sym ${name} 搜）` };

  let addr = v.addr >>> 0;
  if (m){
    const d = /^0x/i.test(m[3]) ? parseInt(m[3].slice(2), 16) : parseInt(m[3], 10);
    addr = (m[2] === '+' ? addr + d : addr - d) >>> 0;
    return { expr: raw, name: raw, kind: 'addr', addr, size: 4, scalar: 'u32', typeName: 'u32', label: raw };
  }
  const t = sym.varType(name);
  if (t?.scalarInfo){
    return {
      expr: raw, name, kind: 'var', addr: t.addr >>> 0, size: t.scalarInfo.size,
      scalar: t.scalar, typeName: t.scalar, label: name,
    };
  }
  if (t){
    // 有 DWARF 但类型不是标量（结构体/数组/指针）：按原始字节摆出来，大小取符号/类型大小
    const size = Math.max(1, Math.min(t.size || 4, 64));
    return { expr: raw, name, kind: 'raw', addr: t.addr >>> 0, size, scalar: null, typeName: t.typeName || `${size} 字节`, label: name };
  }
  // 只有符号表（无 DWARF）
  const size = Math.max(1, Math.min(v.size || 4, 64));
  const scalar = size === 1 ? 'u8' : size === 2 ? 'u16' : size === 4 ? 'u32' : null;
  return {
    expr: raw, name, kind: 'raw', addr: v.addr >>> 0, size,
    scalar, typeName: v.isFunc ? `函数 @ ${hex32(v.addr)}` : (size === 4 ? 'u32' : `${size} 字节`), label: name,
  };
}

/** 读取一个监视项的值（bytes 是刚从目标读回来的原始字节）→ `{text, cls, hex}` */
export function formatWatchValue(item, bytes){
  if (item.error) return { text: item.error, cls: 'err' };
  if (!bytes || !bytes.length) return { text: '（没读到）', cls: 'warn' };
  const ty = item.typeName || item.scalar || `${item.size} 字节`;
  if (item.scalar && SCALARS[item.scalar] && bytes.length >= SCALARS[item.scalar].size){
    const v = decodeScalar(item.scalar, bytes);
    const info = SCALARS[item.scalar];
    const hex = '0x' + readLE(bytes, 0, Math.min(info.size, bytes.length)).toString(16);
    const num = info.float ? (Number.isFinite(v) ? v.toPrecision(6) : String(v)) : String(v);
    return { text: `${num}`, hex, cls: '', type: ty };
  }
  // 没有类型：短的就摆字节，长的给前 8 字节
  const show = [...bytes.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
  const hex = bytes.length <= 4 ? '0x' + readLE(bytes, 0, bytes.length).toString(16) : null;
  return { text: hex ? `${readLE(bytes, 0, bytes.length)}  (${hex})` : `${show}${bytes.length > 8 ? ' …' : ''}`, hex, cls: '', type: ty };
}

/** 监视表（顺序即界面顺序；add/remove 都由它管，好在 Node 里测） */
export class WatchList {
  constructor(items = []){
    this.items = items.map(it => ({ ...it, value: null }));
  }

  get length(){ return this.items.length; }
  indexOf(expr){
    const e = String(expr || '').trim().toLowerCase();
    return this.items.findIndex(it => String(it.expr).trim().toLowerCase() === e);
  }

  /** 加一项；重复（同名）就返回 `{dup:true}` 而不是加第二条 */
  add(expr, sym){
    const item = resolveWatch(expr, sym);
    const i = this.indexOf(item.expr);
    if (i >= 0) return { dup: true, index: i, item: this.items[i] };
    this.items.push({ ...item, value: null });
    return { dup: false, index: this.items.length - 1, item: this.items[this.items.length - 1] };
  }

  /** 删一项：参数可以是编号（1 起）、名字、或 `all` */
  remove(what){
    const s = String(what ?? '').trim();
    if (!s) return { removed: 0 };
    if (s === 'all' || s === '*'){ const n = this.items.length; this.items = []; return { removed: n }; }
    if (/^\d+$/.test(s)){
      const i = parseInt(s, 10) - 1;
      if (i < 0 || i >= this.items.length) return { removed: 0 };
      this.items.splice(i, 1);
      return { removed: 1 };
    }
    const i = this.indexOf(s);
    if (i < 0) return { removed: 0 };
    this.items.splice(i, 1);
    return { removed: 1 };
  }

  clear(){ this.items = []; }

  /** 存 store 用（值不带进去） */
  toJSON(){ return this.items.map(({ expr, name, kind, addr, size, scalar, typeName, label }) =>
    ({ expr, name, kind, addr, size, scalar, typeName, label })); }

  static fromJSON(arr, sym){
    if (!Array.isArray(arr)) return new WatchList();
    const list = new WatchList();
    for (const it of arr){
      const e = it?.expr;
      if (!e) continue;
      // 重新解析一遍：地址/大小可能因为换了 ELF 而不一样，但**认不出来时保留原表达式并标错**
      const fresh = sym ? resolveWatch(e, sym) : { ...it, value: null };
      list.items.push({ ...fresh, value: null });
    }
    return list;
  }
}
