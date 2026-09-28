/**
 * DWARF 4 解析（够"变量浏览器 + 采样"用，不做 line table / loclist / DWARF5）。
 *
 * 为什么要它：`static float pid_kp;` 这类**文件级静态变量在 .symtab 里根本看不见**
 * （实测同一份固件：.symtab 24 个 OBJECT，DWARF 里 48 个带固定地址的变量）。
 * 而且只有 DWARF 才知道"这个 4 字节是 float 还是 int32"—— 类型错了波形就是垃圾。
 *
 * 本文件只做三件事：
 *   1. 走 CU/DIE（abbrev + 表单），把**有固定地址的变量**挑出来；
 *   2. 解析类型链（base/typedef/const/volatile/pointer/array/struct/union/enum），
 *      结构体成员按 `DW_AT_data_member_location` 摊平成"一个成员一路"；
 *   3. 把"不能采样的东西"**连原因一起报出来**（被优化掉了？是数组？在 flash 里？）——
 *      界面要能显示这些原因，点了没反应是最糟的体验。
 *
 * 实测依据（`tools/target-firmware/<例程>/build/fw.elf`，与 pyelftools 对过账）：
 *   🚨 这里**千万别写通配路径** `…​/*​/build/…` —— 注释里出现 `*​/` 会当场把块注释截断，
 *      后面几行就变成代码了。真实症状极具误导性：报错指向**几十行之后**的一个模板字符串
 *      （"Unexpected identifier '里没有'"），而真凶在第 15 行。本项目 2026-09-29 踩过。
 *   版本 = DWARF 4；用到的 form 很窄：name=strp|string、type=ref4、location=exprloc|sec_offset、
 *   data_member_location=data1|data2、upper_bound=data1|data2。
 *   → 所以这里**只实现 DWARF4**；遇到 DWARF5（strx/addrx/line_strp…）直接明确报错，
 *     而不是猜着解析出一堆错地址（`-gdwarf-4` 就能回去，见 stm32f103_scope/build.ps1）。
 *
 * 结构：一次遍历建**索引**（按 offset 升序的记录数组），之后所有查询都是 O(log n)/O(1)。
 * 🚨 不要写成"每次要类型的就去全量扫一遍 DIE"—— 那是 O(n²)，小固件看不出、
 *    真工程（几十万 DIE）会卡死。
 *
 * 🚨 **abbrev 表的 code 号是"表内局部"的**：`.debug_abbrev` 里可以有多张表，每个 CU 用
 *    `DW_AT_abbrev_offset` 指向自己的那张，同一个 code 在不同表里可以是完全不同的 tag/form。
 *    本文件第一版把整段合并成一张表（后解析的覆盖先解析的）→ CU 0 的属性按别人的表来读
 *    → 走位失步 → 报"abbrev 里没有 code 23"（而真凶是表用错了）。必须按 offset 分别解析。
 */
import { cstrAt } from './elf.js';

// ---------------------------------------------------------------- 常量
const TAG = {
  array_type: 0x01, class_type: 0x02, enumeration_type: 0x04, formal_parameter: 0x05,
  lexical_block: 0x0b, member: 0x0d, pointer_type: 0x0f, reference_type: 0x10,
  compile_unit: 0x11, structure_type: 0x13, subroutine_type: 0x15, typedef: 0x16,
  union_type: 0x17, inheritance: 0x1c, subrange_type: 0x21, base_type: 0x24,
  const_type: 0x26, enumerator: 0x28, subprogram: 0x2e, variable: 0x34,
  volatile_type: 0x35, restrict_type: 0x37, namespace: 0x39, unspecified_type: 0x3b,
  rvalue_reference_type: 0x42, atomic_type: 0x47, immutable_type: 0x4b,
};
const AT = {
  location: 0x02, name: 0x03, byte_size: 0x0b, bit_offset: 0x0c, bit_size: 0x0d,
  stmt_list: 0x10, low_pc: 0x11, high_pc: 0x12, language: 0x13, comp_dir: 0x1b,
  const_value: 0x1c, lower_bound: 0x22, producer: 0x25, count: 0x37,
  data_member_location: 0x38, decl_file: 0x3a, decl_line: 0x3b, declaration: 0x3c,
  encoding: 0x3e, external: 0x3f, specification: 0x47, type: 0x49,
  upper_bound: 0x2f, abstract_origin: 0x31, data_bit_offset: 0x6b,
};
const FORM = {
  addr: 0x01, block2: 0x03, block4: 0x04, data2: 0x05, data4: 0x06, data8: 0x07,
  string: 0x08, block: 0x09, block1: 0x0a, data1: 0x0b, flag: 0x0c, sdata: 0x0d,
  strp: 0x0e, udata: 0x0f, ref_addr: 0x10, ref1: 0x11, ref2: 0x12, ref4: 0x13,
  ref8: 0x14, ref_udata: 0x15, indirect: 0x16, sec_offset: 0x17, exprloc: 0x18,
  flag_present: 0x19, data16: 0x1b, ref_sig8: 0x20, implicit_const: 0x21,
};
const DW_ATE = { address: 0x01, boolean: 0x02, complex_float: 0x03, float: 0x04,
  signed: 0x05, signed_char: 0x06, unsigned: 0x07, unsigned_char: 0x08 };
const DW_OP_addr = 0x03, DW_OP_plus_uconst = 0x23;

/** 采样支持的类型表（编码与 HID 0x32 的 type 字节一致，见 docs/scope-page.md §7.1） */
export const SCALARS = {
  u8:  { code: 0, size: 1, signed: false, float: false },
  i8:  { code: 1, size: 1, signed: true,  float: false },
  u16: { code: 2, size: 2, signed: false, float: false },
  i16: { code: 3, size: 2, signed: true,  float: false },
  u32: { code: 4, size: 4, signed: false, float: false },
  i32: { code: 5, size: 4, signed: true,  float: false },
  f32: { code: 6, size: 4, signed: true,  float: true },
  f64: { code: 7, size: 8, signed: true,  float: true },
};

/** 可采样地址窗口：RAM。滤掉 flash/rodata（0x08…）、外设（0x4…），
 *  以及 F4 的 CCM RAM（0x10000000，内核私有总线，AHB-AP 读不到）。 */
export const DEFAULT_RAM = [0x20000000, 0x40000000];

const hex32 = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');

/** 位置表达式（不是 DW_OP_addr 时）→ 人话。这些量**采不了**，但原因要说清楚。 */
function locOpReason(op){
  if (op >= 0x50 && op <= 0x6f) return '在寄存器里（DW_OP_reg*，没有固定地址）';
  if (op >= 0x70 && op <= 0x8f) return '寄存器 + 偏移（DW_OP_breg*，没有固定地址）';
  switch (op){
    case 0x23: return '地址常量 + 偏移（DW_OP_plus_uconst，v1 未支持）';
    case 0x91: return '栈帧相对（DW_OP_fbreg —— 局部变量，没有固定地址）';
    case 0x92: return '静态基址相对（DW_OP_bregx，没有固定地址）';
    case 0x93: case 0x94: case 0x95: case 0x96: return 'TLS 线程局部（没有固定地址）';
    case 0x97: return 'DW_OP_push_object_address（没有固定地址）';
    case 0x9f: return '栈顶解引用（DW_OP_stack_value，没有固定地址）';
    default: return `位置表达式 op=0x${op.toString(16)}（没有固定地址）`;
  }
}

// ---------------------------------------------------------------- 读取器
class R {
  constructor(b, o = 0){ this.b = b; this.o = o; }
  get eof(){ return this.o >= this.b.length; }
  u8(){ return this.b[this.o++]; }
  u16(){ const v = this.b[this.o] | (this.b[this.o + 1] << 8); this.o += 2; return v; }
  u32(){ const b = this.b, o = this.o; this.o += 4;
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  u64(){ const lo = this.u32(), hi = this.u32(); return hi * 4294967296 + lo; }
  uleb(){ let r = 0, s = 0, x; do { x = this.u8(); r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80); return r; }
  sleb(){ let r = 0, s = 0, x; do { x = this.u8(); r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80);
    if (s < 32 && (x & 0x40)) r -= Math.pow(2, s); return r; }
  bytes(n){ const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
}

// ---------------------------------------------------------------- 主类
export class Dwarf {
  constructor(elf){
    this.elf = elf;
    this.info = elf.data('.debug_info');
    this.abbrevRaw = elf.data('.debug_abbrev');
    this.str = elf.data('.debug_str');
    if (!this.info.length) throw new Error('这个 ELF 没有 .debug_info —— 不是 -g 构建，或者被 strip 过');
    this._abbrCache = null;       // abbrev 表缓存：**按 offset 分表**（key = DW_AT_abbrev_offset）
    this._types = new Map();      // DIE offset → 类型对象（记忆化）
    this._arr = null;             // 索引：按 offset 升序的记录数组
    this._byOff = new Map();
    this.stats = { cu: 0, dies: 0, vars: 0 };
  }

  static available(elf){ return !!(elf.section('.debug_info')?.size); }

  /** 各 CU 的版本号（用来给出"请用 -gdwarf-4"这种可执行的建议）*/
  versions(){
    const out = [];
    for (const cu of this.cus()) out.push(cu.version);
    return out;
  }

  /** 缩写表（**按 CU 的 DW_AT_abbrev_offset 分别解析**，见下）*/
  abbrevAt(offset){
    if (!this._abbrCache) this._abbrCache = new Map();
    if (this._abbrCache.has(offset)) return this._abbrCache.get(offset);
    const map = new Map();
    const r = new R(this.abbrevRaw, offset);
    while (!r.eof){
      const code = r.uleb();
      if (!code) break;                          // 0 = 这张表结束（后面可能还有别的 CU 的表）
      const tag = r.uleb();
      const children = r.u8() !== 0;
      const attrs = [];
      for (;;){
        const at = r.uleb(), form = r.uleb();
        if (!at && !form) break;
        let ic = null;
        if (form === FORM.implicit_const) ic = r.sleb();
        attrs.push([at, form, ic]);
      }
      map.set(code, { tag, children, attrs });
    }
    this._abbrCache.set(offset, map);
    return map;
  }

  /** 所有缩写的集合（排障用：看看到底有几张表）*/
  abbrevTables(){
    const tables = new Map();
    let o = 0;
    while (o < this.abbrevRaw.length){
      const before = o;
      const map = this.abbrevAt(o);
      tables.set(o, map);
      // 找出这张表结束的位置：重新扫一遍（便宜，排障时才用）
      const r = new R(this.abbrevRaw, o);
      while (!r.eof){
        const code = r.uleb();
        if (!code){ o = r.o; break; }
        r.uleb(); r.u8();
        for (;;){ const at = r.uleb(), f = r.uleb(); if (!at && !f) break; if (f === FORM.implicit_const) r.sleb(); }
      }
      if (o === before) break;
    }
    return tables;
  }

  /** 遍历编译单元头 */
  *cus(){
    const b = this.info;
    let o = 0;
    while (o + 11 < b.length){
      const r = new R(b, o);
      let len = r.u32();
      const is64 = len === 0xffffffff;
      if (is64) len = r.u64();
      if (!len) break;
      const end = r.o + len;
      const version = r.u16();
      let abbrevOff, addrSize;
      if (version >= 5){
        r.u8();                                  // unit_type
        addrSize = r.u8();
        abbrevOff = r.u32();
      } else {
        abbrevOff = r.u32();
        addrSize = r.u8();
      }
      yield { offset: o, version, abbrevOff, addrSize, dieOff: r.o, end: Math.min(end, b.length) };
      o = end;
    }
  }

  /** 读一个 DIE；返回 {tag, attrs, offset, hasChildren} 或 null（null DIE）*/
  _die(r, abbr, cu){
    const offset = r.o;
    const code = r.uleb();
    if (!code) return null;
    const a = abbr.get(code);
    if (!a) throw new Error(`.debug_abbrev 里没有 code ${code}（offset ${offset}）—— 文件坏了？`);
    const attrs = new Map();
    for (const [at, form, ic] of a.attrs) attrs.set(at, this._value(r, form, ic, cu));
    return { tag: a.tag, attrs, offset, hasChildren: a.children };
  }

  _value(r, form, ic, cu){
    switch (form){
      case FORM.addr: return { form, value: cu.addrSize === 8 ? r.u64() : r.u32() };
      case FORM.data1: case FORM.flag: return { form, value: r.u8() };
      case FORM.data2: return { form, value: r.u16() };
      case FORM.data4: return { form, value: r.u32() };
      case FORM.data8: return { form, value: r.u64() };
      case FORM.data16: return { form, value: r.bytes(16) };
      case FORM.sdata: return { form, value: r.sleb() };
      case FORM.udata: return { form, value: r.uleb() };
      case FORM.string: { const s = r.o; while (!r.eof && r.b[r.o]) r.o++;
        const v = cstrAt(r.b, s); r.u8(); return { form, value: v }; }
      case FORM.strp: { const off = r.u32(); return { form, value: cstrAt(this.str, off) }; }
      case FORM.block1: { const n = r.u8(); return { form, value: r.bytes(n) }; }
      case FORM.block2: { const n = r.u16(); return { form, value: r.bytes(n) }; }
      case FORM.block4: { const n = r.u32(); return { form, value: r.bytes(n) }; }
      case FORM.block: { const n = r.uleb(); return { form, value: r.bytes(n) }; }
      case FORM.exprloc: { const n = r.uleb(); return { form, value: r.bytes(n) }; }
      case FORM.flag_present: return { form, value: 1 };
      case FORM.sec_offset: return { form, value: r.u32() };      // 位置/范围列表偏移
      case FORM.ref1: return { form, value: cu.offset + r.u8() };
      case FORM.ref2: return { form, value: cu.offset + r.u16() };
      case FORM.ref4: return { form, value: cu.offset + r.u32() };
      case FORM.ref8: return { form, value: cu.offset + r.u64() };
      case FORM.ref_udata: return { form, value: cu.offset + r.uleb() };
      case FORM.ref_addr: return { form, value: r.u32(), unresolved: true };
      case FORM.ref_sig8: r.skip(8); return { form, value: null };
      case FORM.implicit_const: return { form, value: ic };
      case FORM.indirect: { const f2 = r.uleb(); return this._value(r, f2, ic, cu); }
      default:
        throw new Error(`不支持的 DWARF form 0x${form.toString(16)}` +
          (form >= 0x1a && form <= 0x2c ? '（这是 DWARF 5 的表单：请用 -gdwarf-4 重新编译目标固件）' : ''));
    }
  }

  /** 一次遍历建索引（O(n)）。记录：{offset, end, tag, attrs, parent, depth, cu} */
  index(){
    if (this._arr) return this;
    const arr = [], byOff = new Map(), stack = [];
    for (const cu of this.cus()){
      this.stats.cu++;
      const abbr = this.abbrevAt(cu.abbrevOff);      // 🚨 每个 CU 用自己的那张表
      const r = new R(this.info, cu.dieOff);
      stack.length = 0;
      while (r.o < cu.end){
        const die = this._die(r, abbr, cu);
        if (!die){                                   // null DIE：兄弟链结束
          const top = stack.pop();
          if (top) top.end = r.o - 1;
          continue;
        }
        this.stats.dies++;
        if (this.stats.dies > 4_000_000) throw new Error('DIE 数量异常（>400 万）：调试信息有问题');
        const rec = { offset: die.offset, end: cu.end, tag: die.tag, attrs: die.attrs,
                      parent: stack.length ? stack[stack.length - 1].offset : -1,
                      depth: stack.length, cu, children: die.hasChildren };
        arr.push(rec);
        byOff.set(rec.offset, rec);
        if (die.hasChildren) stack.push(rec);
      }
    }
    // 叶子的 end = 下一条记录的 offset（父节点已经在 null DIE 处填好了）
    for (let i = 0; i < arr.length; i++){
      if (!arr[i].children && i + 1 < arr.length) arr[i].end = arr[i + 1].offset;
    }
    this._arr = arr;
    this._byOff = byOff;
    return this;
  }

  /** 直接子 DIE（利用索引区间，O(子树大小)）*/
  childrenOf(rec){
    this.index();
    const out = [];
    const arr = this._arr;
    let i = upperBound(arr, rec.offset);
    for (; i < arr.length && arr[i].offset < rec.end; i++){
      if (arr[i].parent === rec.offset) out.push(arr[i]);
    }
    return out;
  }

  dieAt(offset){ this.index(); return this._byOff.get(offset) || null; }
  attr(rec, at){ return rec?.attrs.get(at); }
  name(rec){ const a = rec?.attrs.get(AT.name); return a && typeof a.value === 'string' ? a.value : ''; }
  num(rec, at){ const a = rec?.attrs.get(at); return a && typeof a.value === 'number' ? a.value : null; }

  /**
   * 把 `DW_AT_specification` / `DW_AT_abstract_origin` 链上的属性**并进来**（缺什么补什么）。
   *
   * 为什么必须做：GCC 给"定义"发的 DIE 可能**只有地址没有名字/类型**，名字和类型在它引用的
   * "声明" DIE 上（实测：`_SEGGER_RTT` 在 SEGGER_RTT.c 里是 `SECTION(...)` 宏包着的定义，
   * 定义 DIE 无名无类型、地址 0x200000c；声明 DIE 有名字和 `SEGGER_RTT_CB` 类型）。
   * 不做这一步的表现是：一个**无名**变量被悄悄丢掉 —— 而它恰恰是 RTT 控制块。
   */
  merged(rec){
    if (!rec) return null;
    if (rec._merged) return rec._merged;
    const attrs = new Map(rec.attrs);
    let cur = rec, depth = 0;
    while (depth++ < 8){
      const spec = this.num(cur, AT.specification) ?? this.num(cur, AT.abstract_origin);
      if (spec == null) break;
      const target = this.dieAt(spec);
      if (!target) break;
      for (const [k, v] of target.attrs){
        // 🚨 不要从"声明"那侧继承 DW_AT_declaration —— 否则定义 DIE 会被自己当成声明丢掉
        if (k === AT.declaration) continue;
        if (!attrs.has(k)) attrs.set(k, v);
      }
      cur = target;
    }
    const out = { offset: rec.offset, end: rec.end, tag: rec.tag, parent: rec.parent,
                  depth: rec.depth, cu: rec.cu, children: rec.children, attrs };
    rec._merged = out;
    return out;
  }

  /**
   * 解析类型链（记忆化）。
   * → {kind:'scalar'|'struct'|'union'|'array'|'pointer'|'unknown', size, scalar?, members?, elem?, count?}
   */
  type(refOff){
    if (refOff == null) return { kind: 'unknown', size: 0, reason: '没有 DW_AT_type' };
    if (this._types.has(refOff)) return this._types.get(refOff);
    const rec = this.dieAt(refOff);
    const out = rec ? this._typeOf(rec) : { kind: 'unknown', size: 0, reason: '类型 DIE 找不到（可能被裁剪）' };
    this._types.set(refOff, out);
    return out;
  }

  _typeOf(rec){
    const size = () => this.num(rec, AT.byte_size) ?? 0;
    switch (rec.tag){
      case TAG.base_type: {
        const enc = this.num(rec, AT.encoding);
        const sz = size() || 1;
        const nm = this.name(rec);
        let key = null;
        if (enc === DW_ATE.float || enc === DW_ATE.complex_float) key = sz === 4 ? 'f32' : sz === 8 ? 'f64' : null;
        else if (enc === DW_ATE.boolean) key = sz === 1 ? 'u8' : null;
        else if (enc === DW_ATE.signed || enc === DW_ATE.signed_char) key = sz === 1 ? 'i8' : sz === 2 ? 'i16' : sz === 4 ? 'i32' : null;
        else if (enc === DW_ATE.unsigned || enc === DW_ATE.unsigned_char) key = sz === 1 ? 'u8' : sz === 2 ? 'u16' : sz === 4 ? 'u32' : null;
        if (!key){
          return { kind: 'scalar', size: sz, scalar: null, name: nm || '?',
                   reason: `类型 ${nm || '?'}（${sz} B）不在采样类型表里（v1 支持 u8/u16/u32、i8/i16/i32、f32/f64）` };
        }
        return { kind: 'scalar', size: sz, scalar: key, name: nm };
      }
      case TAG.typedef: {
        const t = this.type(this.num(rec, AT.type));
        return { ...t, alias: this.name(rec) || t.alias };
      }
      case TAG.const_type: case TAG.volatile_type: case TAG.restrict_type:
      case TAG.atomic_type: case TAG.immutable_type:
        return this.type(this.num(rec, AT.type));
      case TAG.pointer_type: case TAG.reference_type: case TAG.rvalue_reference_type:
        return { kind: 'pointer', size: size() || 4, to: this.num(rec, AT.type) };
      case TAG.enumeration_type: {
        const sz = size() || 4;
        const key = sz === 1 ? 'u8' : sz === 2 ? 'u16' : sz <= 4 ? 'u32' : null;
        const nm = this.name(rec) || 'enum';
        return key ? { kind: 'scalar', size: sz, scalar: key, name: nm, enum: true }
                   : { kind: 'scalar', size: sz, scalar: null, name: nm, reason: `${sz} 字节的枚举不在采样类型表里` };
      }
      case TAG.structure_type: case TAG.class_type: case TAG.union_type: {
        const members = [];
        for (const d of this.childrenOf(rec)){
          if (d.tag !== TAG.member) continue;
          const off = this._memberOffset(d);
          const bits = this.num(d, AT.bit_size);
          members.push({
            name: this.name(d) || '(匿名)',
            offset: off,
            type: this.type(this.num(d, AT.type)),
            bitSize: bits ?? null,
            reason: bits ? '位域（v1 不支持）' : (off === null ? '成员偏移不是常量（DWARF 表达式）' : null),
          });
        }
        return { kind: rec.tag === TAG.union_type ? 'union' : 'struct', size: size(),
                 name: this.name(rec), members };
      }
      case TAG.array_type: {
        const elem = this.type(this.num(rec, AT.type));
        let count = null;
        for (const d of this.childrenOf(rec)){
          if (d.tag !== TAG.subrange_type) continue;
          const ub = this.num(d, AT.upper_bound), c = this.num(d, AT.count), lb = this.num(d, AT.lower_bound) ?? 0;
          if (c != null) count = c;
          else if (ub != null) count = ub - lb + 1;
          break;
        }
        const sz = size() || (count != null ? count * (elem.size || 0) : 0);
        return { kind: 'array', size: sz, elem, count };
      }
      case TAG.unspecified_type:
        return { kind: 'unknown', size: size(), reason: `unspecified_type（${this.name(rec) || '?'}）` };
      case TAG.subroutine_type:
        return { kind: 'unknown', size: 0, reason: '函数类型' };
      default:
        return { kind: 'unknown', size: size(), reason: `未处理的 tag 0x${rec.tag.toString(16)}` };
    }
  }

  _memberOffset(rec){
    const a = rec.attrs.get(AT.data_member_location);
    if (!a) return 0;
    if (typeof a.value === 'number') return a.value;
    if (a.value instanceof Uint8Array){                    // exprloc：只认 DW_OP_plus_uconst
      const e = a.value;
      if (e[0] === DW_OP_plus_uconst) return new R(e, 1).uleb();
    }
    return null;
  }

  /** 从 DW_AT_location 的 exprloc 里取固定地址（`DW_OP_addr <addr>`）*/
  fixedAddr(rec){
    const loc = rec.attrs.get(AT.location);
    if (!loc) return { addr: null, reason: '没有 DW_AT_location（只是声明 / 被优化掉）' };
    if (loc.form === FORM.sec_offset) return { addr: null, reason: '位置列表（被优化进寄存器/栈，没有固定地址）' };
    const e = loc.value;
    const as = rec.cu.addrSize;
    if (!(e instanceof Uint8Array) || e.length < 1 + as) return { addr: null, reason: '位置表达式看不懂' };
    if (e[0] !== DW_OP_addr) return { addr: null, reason: locOpReason(e[0]) };
    let addr = 0;
    for (let i = as - 1; i >= 0; i--) addr = addr * 256 + e[1 + i];
    return { addr: addr >>> 0, tail: e.length > 1 + as };
  }

  /**
   * 列出可采样的"通道"。
   * @param {{ram?:[number,number], maxDepth?:number}} opts
   */
  listVariables({ ram = DEFAULT_RAM, maxDepth = 4 } = {}){
    this.index();
    const sampleable = [], skipped = [];
    const inRam = a => a >= ram[0] && a < ram[1];

    const leaves = (name, addr, type, group, depth) => {
      if (depth > maxDepth){ skipped.push({ name, reason: '结构体嵌套太深（>4 层）' }); return; }
      if (!type || type.kind === 'unknown'){ skipped.push({ name, size: type?.size, reason: type?.reason || '类型未知' }); return; }
      if (type.kind === 'pointer'){ skipped.push({ name, size: type.size, reason: '指针（要指针跟踪才能采，v1 不做）' }); return; }
      if (type.kind === 'array'){
        const c = type.count != null ? `${type.count} 个` : '? 个';
        skipped.push({ name, size: type.size, reason: `数组（${c}${type.elem?.name || ''}）—— v1 只支持标量与结构体成员` });
        return;
      }
      if (type.kind === 'struct' || type.kind === 'union'){
        if (!type.members?.length){ skipped.push({ name, size: type.size, reason: '空结构体 / 没有可采样成员' }); return; }
        for (const m of type.members){
          const child = `${name}.${m.name}`;
          if (m.reason){ skipped.push({ name: child, size: m.type?.size, reason: m.reason }); continue; }
          leaves(child, (addr + m.offset) >>> 0, m.type, group, depth + 1);
        }
        return;
      }
      if (type.kind === 'scalar'){
        if (!type.scalar){ skipped.push({ name, size: type.size, reason: type.reason || '类型不在采样表里' }); return; }
        if (!inRam(addr)){ skipped.push({ name, size: type.size, reason: `地址 ${hex32(addr)} 不在 RAM 窗口 ${hex32(ram[0])}~${hex32(ram[1])}` }); return; }
        sampleable.push({ name, label: name, addr, size: type.size, scalar: type.scalar,
                          typeName: type.name || type.scalar, group: group || name, path: name });
        return;
      }
      skipped.push({ name, size: type.size, reason: type.reason || `不支持的类型（${type.kind}）` });
    };

    for (const rec0 of this._arr){
      if (rec0.tag !== TAG.variable) continue;
      this.stats.vars++;
      const rec = this.merged(rec0);                    // 名字/类型可能在"声明"那一头
      const nm = this.name(rec);
      if (!nm){ skipped.push({ name: `(无名变量 @${rec0.offset})`, reason: 'DWARF 里没有名字（也追不到声明）' }); continue; }
      if (rec.attrs.get(AT.declaration)) continue;                    // 只是声明
      const fa = this.fixedAddr(rec);
      if (fa.addr == null){ skipped.push({ name: nm, reason: fa.reason }); continue; }
      leaves(nm, fa.addr, this.type(this.num(rec, AT.type)), nm, 0);
    }
    sampleable.sort((a, b) => a.addr - b.addr || a.name.localeCompare(b.name));
    return { sampleable, skipped, stats: { ...this.stats } };
  }
}

function upperBound(arr, offset){
  let lo = 0, hi = arr.length;
  while (lo < hi){ const mid = (lo + hi) >> 1; if (arr[mid].offset <= offset) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * 一步到位：给一个 ELF，拿到"能采样的通道 + 采不了的原因"。
 * 没有 DWARF 时**退化**到符号表（有地址有大小，但没有类型 —— 界面必须让用户手选类型）。
 */
export function listSampleable(elf, opts = {}){
  if (Dwarf.available(elf)){
    const dw = new Dwarf(elf);
    const versions = [...new Set(dw.versions())];
    const bad = versions.filter(v => v >= 5);
    if (bad.length){
      throw new Error(`目标固件的调试信息是 DWARF ${bad.join('/')}，本页只支持 DWARF 4 —— ` +
        '请在工程里加 -gdwarf-4（GCC/armclang 同名选项）重新编译');
    }
    const r = dw.listVariables(opts);
    return { ...r, source: 'dwarf', versions };
  }
  return listFromSymtab(elf, opts);
}

/** 没有 DWARF 时的退化路径：符号表（有地址有大小、**没有类型** → 界面必须让用户手选类型）*/
export function listFromSymtab(elf, opts = {}){
  const [lo, hi] = opts.ram || DEFAULT_RAM;
  const sampleable = [], skipped = [];
  for (const s of elf.symbols()){
    if (!s.isObject || !s.name) continue;
    if (!s.size){ skipped.push({ name: s.name, reason: '符号大小为 0（类型/数组长度未知）' }); continue; }
    if (s.addr < lo || s.addr >= hi){ skipped.push({ name: s.name, size: s.size, reason: `地址 ${hex32(s.addr)} 不在 RAM 窗口` }); continue; }
    sampleable.push({ name: s.name, label: s.name, addr: s.addr, size: s.size, scalar: null,
                      typeName: '未知（请手选类型）', group: s.name, path: s.name });
  }
  return { sampleable, skipped, stats: { vars: sampleable.length + skipped.length },
           source: 'symtab', versions: [] };
}
