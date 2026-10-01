/**
 * 符号表（ELF）—— 调试页的 "gdb 感" 全靠它：`p g_var`、`b main`、PC 落点显示。
 *
 * 数据来源两路（都复用已有模块，不重复造）：
 *   · `Elf.symbols()`：完整符号表（函数 + 变量，含地址与大小）—— 一定能拿到；
 *   · `listSampleable(elf)`：DWARF 解析出的**带类型**的全局/静态变量（J-Scope 页在用同一个）——
 *     有它才能 `p` 出数值；没有 DWARF 时退化成"只显示地址与字节"。
 *
 * 🚨 与 J-Scope 页**刻意不同**的一点：那边只列 RAM 窗口里的可采样变量（波形只能采 RAM），
 *    调试页的 `p` 要能打印 **flash 里的常量/查表**（`p kSinHi[3]` 这种很常用），
 *    所以这里不做 RAM 过滤，符号表里的东西全都要能按名字查到。
 */

import { Elf } from '../elf/elf.js';
import { listSampleable, SCALARS } from '../elf/dwarf.js';
import { hex32, parseNum } from './fmt.js';

const byAddr = (a, b) => a.addr - b.addr;

export class SymTab {
  constructor(parts = {}){
    this.all = parts.all || [];            // 全部符号（含未命名/无大小的）
    this.funcs = (parts.funcs || []).slice().sort(byAddr);
    this.objs = (parts.objs || []).slice().sort(byAddr);
    this.vars = parts.vars || [];          // 带类型的变量（DWARF 优先）
    this.varByName = new Map();
    for (const v of this.vars) if (!this.varByName.has(v.name)) this.varByName.set(v.name, v);
    this.byName = new Map();
    // 先放已归一化的函数/数据符号（函数抹掉 Thumb 位），剩下的才轮到原始表
    for (const s of [...this.funcs, ...this.objs, ...this.all]) if (s.name && !this.byName.has(s.name)) this.byName.set(s.name, s);
    this.source = parts.source || 'symtab';
    this.note = parts.note || '';
    this.ram = parts.ram || null;
    this.versions = parts.versions || [];
  }

  /** @param {ArrayBuffer|Uint8Array} buf .elf 文件内容 */
  static fromBuffer(buf){
    const elf = buf instanceof Elf ? buf : new Elf(buf);
    const all = elf.symbols().filter(s => s.name);
    /**
     * 🚨 Thumb 函数的符号值**带 bit0=1**（0x08000041 = SysTick_Handler）
     *    —— 那是"这是 Thumb 代码"的标记，不是地址的一部分。
     *    不抹掉的话 `funcAt(0x08000044)` 会算出 +3 的偏移、`nameOf` 显示 +3、断点也会偏 1。
     *    （数据符号没有这个标记，原样保留。）
     */
    const funcs = all.filter(s => s.isFunc && s.addr).map(s => ({ ...s, addr: (s.addr & ~1) >>> 0 }));
    const objs = all.filter(s => s.isObject && s.addr);
    let vars = [], source = 'symtab', note = '', ram = null, versions = [];
    try {
      const r = listSampleable(elf);
      vars = (r.sampleable || []).map(v => ({
        name: v.name, addr: v.addr >>> 0, size: v.size >>> 0,
        scalar: v.scalar || null, typeName: v.typeName || null, path: v.path || v.name,
      }));
      source = r.source || 'symtab';
      note = r.note || '';
      ram = r.ram || null;
      versions = r.versions || [];
    } catch (e){
      note = `DWARF 解析失败（${e?.message || e}）：只能按符号表显示地址与原始字节`;
    }
    return new SymTab({ all, funcs, objs, vars, source, note, ram, versions });
  }

  get size(){ return this.all.length; }
  get varCount(){ return this.vars.length; }

  /** 一句话摘要（界面状态条用） */
  summary(){
    const s = `${this.size} 个符号（函数 ${this.funcs.length} · 数据 ${this.objs.length}）`;
    const t = this.varCount ? `，其中 ${this.varCount} 个带类型变量（${this.source === 'dwarf' ? 'DWARF' : '符号表'}）` : '，没有类型信息（无 DWARF）';
    return s + t + (this.note ? `　⚠ ${this.note}` : '');
  }

  /** 地址落在哪个函数里（PC 落点显示）：返回 {name, addr, off, exact} */
  funcAt(addr){
    addr = (addr >>> 0) & ~1;                 // Thumb 地址（LR 可能带 bit0=1）
    let best = null;
    for (const f of this.funcs){
      if (f.addr > addr) break;
      best = f;
    }
    if (!best) return null;
    const off = (addr - best.addr) >>> 0;
    const exact = best.size ? off < best.size : true;       // 大小为 0（汇编/裁剪过）时只能"就近算"
    return { name: best.name, addr: best.addr, size: best.size, off, exact };
  }

  /** 地址 → 人话："main+0x14" / "0x08000123+0x14?" */
  nameOf(addr){
    const f = this.funcAt(addr);
    if (!f) return hex32(addr);
    const tail = f.off ? '+0x' + f.off.toString(16) : '';
    return f.name + tail + (f.exact ? '' : '?');
  }

  /** 按名字精确查（变量 → 函数 → 数据对象） */
  find(name){
    const n = String(name || '').trim();
    if (!n) return null;
    const v = this.varByName.get(n);
    if (v) return { ...v, kind: 'var' };
    const s = this.byName.get(n);
    if (s) return { name: s.name, addr: s.addr >>> 0, size: s.size >>> 0, kind: s.isFunc ? 'func' : 'obj' };
    return null;
  }

  /** 模糊搜（`sym <子串>`），最多 limit 条 */
  search(sub, limit = 40){
    const q = String(sub || '').toLowerCase();
    if (!q) return [];
    const out = [];
    for (const v of this.vars) if (v.name.toLowerCase().includes(q)) out.push({ ...v, kind: 'var', typed: true });
    for (const s of [...this.funcs, ...this.objs]){
      if (out.length >= limit) break;
      if (!s.name.toLowerCase().includes(q)) continue;
      if (out.some(o => o.name === s.name)) continue;
      out.push({ name: s.name, addr: s.addr >>> 0, size: s.size >>> 0, kind: s.isFunc ? 'func' : 'obj', typed: false });
    }
    return out.slice(0, limit);
  }

  /**
   * 把命令行里的一段文本解析成地址。支持：
   *   `0x08000123` / `1234`（十进制） / `main` / `main+0x10` / `g_var-4` / `&g_var` / `*0x20000000`
   * @returns {{addr:number, sym:object|null, off:number, deref:boolean}|null}
   */
  resolve(text){
    const s = String(text ?? '').trim();
    if (!s) return null;
    const deref = s.startsWith('*');
    let t = deref ? s.slice(1).trim() : s;
    const amp = t.startsWith('&');                            // &var：要的是变量自己的地址
    if (amp) t = t.slice(1).trim();
    const direct = parseNum(t);
    if (direct !== null && /^(0x|0b|0o|\d)/i.test(t)) return { addr: direct >>> 0, sym: null, off: 0, deref };
    // 符号 ± 偏移
    const m = /^([A-Za-z_.$][\w.$]*)\s*([+-])\s*(0x[0-9a-f]+|\d+)$/i.exec(t);
    const name = m ? m[1] : t;
    const sym = this.find(name);
    if (!sym) return null;
    let addr = sym.addr;
    if (m){
      const delta = parseNum(m[3]) || 0;
      addr = m[2] === '+' ? (addr + delta) : (addr - delta);
    }
    return { addr: addr >>> 0, sym, off: m ? (parseNum(m[3]) || 0) : 0, deref };
  }

  /** 变量的类型信息（`p` 用）：scalar 是 SCALARS 里的名字时才能解出数值 */
  varType(name){
    const v = this.varByName.get(String(name || '').trim());
    if (!v) return null;
    return { ...v, scalarInfo: v.scalar && SCALARS[v.scalar] ? SCALARS[v.scalar] : null };
  }
}
