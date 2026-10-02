/**
 * 调试命令行（gdb 风格的最小子集）—— **纯逻辑**，只通过一个 session 接口跟硬件打交道。
 *
 * 为什么值得单独一层：命令解析 + 输出格式化最容易写错（地址解析、长度默认值、
 * 断点编号……），而它们全都能在没有硬件的情况下测到底 —— 自测里喂一个假 session 就行。
 *
 * 约定：
 *   · 所有命令返回 `{lines:[{t,c}], clear?}`；`c` 是行样式（ok/err/warn/dim）
 *   · 命令不认识 → 抛错（由 view 显示成红色），**不要静默无反应**（用户会以为按钮坏了）
 *   · 每条命令执行前后都刷新一次状态（halted/pc），这样"继续"之后 PC 显示是对的
 */

import { hex32, hex8, hexdump, parseBytes, parseNum, readLE } from './fmt.js';
import { decodeXpsr, formatXpsr, regInfo, SPECIAL_REGS, cfbpGet, formatSpecial } from './regs.js';

const L = (t, c) => ({ t, c });

/** 解析一行命令：`md 0x2000 0x40` → {cmd:'md', args:['0x2000','0x40']} */
export function parseCmd(line){
  const raw = String(line ?? '').trim();
  if (!raw) return null;
  const sp = raw.search(/\s/);
  const cmd = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? '' : raw.slice(sp + 1).trim();
  return { cmd, args: rest ? rest.split(/\s+/) : [], rest, raw };
}

/** 把 `0x20001000`、`g_var`、`main+4` 解析成地址（失败抛人话错误） */
function addrOf(s, args = {}){
  const sym = args.session?.sym;
  const r = sym?.resolve(s);
  if (r) return r;
  throw new Error(`认不出地址/符号：「${s}」${sym ? '' : '（还没载入 .elf，只能写十六进制地址）'}`);
}

const HELP = [
  '命令（大小写不敏感；地址可以是 0x… 或符号名）：',
  '  h / help              这份帮助',
  '  c / cont              继续运行（PC 停在断点上时会自动跨过它）',
  '  s / step              单步一条指令（会临时屏蔽中断）',
  '  halt                  暂停目标',
  '  reset [run|halt]      复位（默认停住；run = 复位后直接跑）',
  '  r                     打印全部寄存器',
  '  r <reg>               打印一个寄存器（r0…r15 / sp / lr / pc / xpsr / primask / basepri / faultmask / control / msp / psp）',
  '  r <reg> <值>          改寄存器（例：r pc main+8、r r0 0x1234、r primask 0）',
  '  md <地址> [长度]      读内存（默认 64 字节）',
  '  mw <地址> <字节…>     写内存（例：mw 0x20000000 01 02 ff）',
  '  ms <地址> <文本>      写字符串（不含结尾 0）',
  '  p <变量>              打印变量（有 DWARF 时按类型解出数值）',
  '  x <地址|&变量> [长度] 同 md，但先把符号解释成人话',
  '  b <地址|符号>         加硬件断点（FPB）',
  '  bd <编号|地址|all>    删断点（编号见 bl）',
  '  bl                    列出断点',
  '  w <变量>              加进「监视」窗口（停止时自动刷新；也支持 符号+偏移 / 0x地址）',
  '  wl                    列出监视项与当前值',
  '  wd <编号|名字|all>    删监视项',
  '  sl                    当前源码位置（PC 落在哪个文件哪一行）',
  '  src [文件:行]         列出有行号信息的源文件 / 把源码视图跳到指定位置',
  '  info                  目标信息（后端/时钟/状态/断点容量/符号摘要）',
  '  sym <子串>            搜符号',
  '  cls                   清屏',
  '',
  '界面上的手感：Tab 补全 · ↑↓ 翻历史 · Ctrl+C 中断 · Ctrl+L 清屏 · 粘多行会排队执行。',
];

/** Ctrl+C 用：命令执行到一半被取消（由 view 捕获并显示成 ^C） */
export class Cancelled extends Error {
  constructor(){ super('已中断'); this.cancelled = true; this.name = 'Cancelled'; }
}

/** 每步操作前问一下"用户按 Ctrl+C 了吗"——浏览器取消不了正在飞的 USB 传输，所以只能逐步检查 */
export function checkCancel(opts){
  const s = opts?.signal;
  const v = typeof s === 'function' ? s() : s?.cancelled;
  if (v) throw new Cancelled();
}

/**
 * 执行一条命令。
 * @param {string} line 用户输入
 * @param {object} session 调试会话（见 app/dbg/session.js 的 DebugSession；测试里用假的）
 * @param {object} [opts] `{session, view, signal}` —— view 给监视窗口/源码视图用，signal 是 Ctrl+C 的查询函数
 * @returns {Promise<{lines:Array<{t:string,c?:string}>, clear?:boolean}>}
 */
export async function runCmd(line, session, opts = {}){
  const p = parseCmd(line);
  if (!p) return { lines: [] };
  checkCancel(opts);
  return await runCmdInner(p, session, opts);
}

async function runCmdInner(p, session, opts = {}){
  const { cmd, args, rest } = p;
  const S = session;
  const V = opts.view || null;
  const lines = [];
  const need = () => { if (!S?.connected) throw new Error('还没连接目标（先点「连接」）'); };

  switch (cmd){
    case 'h': case 'help': case '?':
      return { lines: HELP.map(t => L(t, 'dim')) };

    case 'cls':
      return { lines: [], clear: true };

    case 'c': case 'cont': case 'continue': case 'g':
      need();
      await S.cont();
      return { lines: [L('继续运行（遇到断点或暂停为止）', 'ok'), L(statusLine(S), 'dim')] };

    case 's': case 'step': case 'si': case 'n': case 'next':
      need();
      await S.step();
      return { lines: [L('单步完成　' + statusLine(S), 'ok'), L(regLine(S, 'PC'), 'dim')] };

    case 'halt': case 'stop': case 'pause':
      need();
      await S.halt();
      return { lines: [L('已暂停　' + statusLine(S), 'ok')] };

    case 'reset': {
      need();
      const how = (args[0] || 'halt').toLowerCase();
      if (how === 'run' || how === 'r' || how === 'go'){
        const msg = await S.resetRun();
        return { lines: [L('复位并运行' + (msg ? `（${msg}）` : ''), 'ok')] };
      }
      if (how !== 'halt' && how !== 'h' && how !== 'stop') throw new Error('用法：reset [run|halt]');
      const msg = await S.resetHalt();
      return { lines: [L('复位并停住' + (msg ? `（${msg}）` : '') + '　' + statusLine(S), 'ok'), L(regLine(S, 'PC'), 'dim')] };
    }

    case 'r': case 'regs': case 'reg': {
      need();
      if (!args.length){
        await S.refreshRegs();
        for (const r of S.regList()) lines.push(L(fmtReg(r, S), r.changed ? 'warn' : undefined));
        return { lines };
      }
      const info = regInfo(args[0]);
      if (!info) throw new Error(`不认识的寄存器：「${args[0]}」（用 r 看全部）`);
      if (args.length === 1){
        const v = await S.readReg(args[0]);
        return { lines: [L(fmtReg({ ...info, name: normName(info), value: v }, S))] };
      }
      const v = parseNum(args[1]);
      if (v === null) throw new Error(`认不出数值：「${args[1]}」`);
      await S.writeReg(args[0], v);
      const back = await S.readReg(args[0]);
      return { lines: [L(`${normName(info)} ← ${fmtReg({ ...info, name: normName(info), value: back }, S)}`, back === v ? 'ok' : 'warn'),
                       ...(back === v ? [] : [L(`（回读是 0x${(back >>> 0).toString(16)}，与写入值不同 —— 有些位是只读/由硬件改写的）`, 'warn')])] };
    }

    case 'md': case 'x': {
      need();
      if (!args.length) throw new Error(`用法：${cmd} <地址|&变量> [长度]`);
      const a = addrOf(args[0], { session: S });
      const len = args[1] ? parseNum(args[1]) : 64;
      if (len === null) throw new Error(`认不出长度：「${args[1]}」`);
      if (!len || len > 4096) throw new Error('长度要在 1~4096 之间');
      const bytes = await S.memRead(a.addr, len);
      checkCancel(opts);                                    // 长读之后再看一眼 Ctrl+C
      const head = `${a.sym ? `${a.sym.name}${a.deref ? '（解引用）' : ''} ` : ''}${hex32(a.addr)} 起 ${bytes.length} 字节：`;
      lines.push(L(head, 'dim'));
      for (const l of hexdump(bytes, a.addr)) lines.push(L(l));
      return { lines };
    }

    case 'mw': {
      need();
      if (args.length < 2) throw new Error('用法：mw <地址> <字节…>（例：mw 0x20000000 01 02 ff）');
      const a = addrOf(args[0], { session: S });
      const bytes = parseBytes(args.slice(1).join(' '));
      if (!bytes.length) throw new Error('没给出要写的字节');
      await S.memWrite(a.addr, bytes);
      const back = await S.memRead(a.addr, bytes.length);
      let same = back.length === bytes.length;
      for (let i = 0; same && i < bytes.length; i++) if (back[i] !== bytes[i]) same = false;
      return { lines: [L(`写 ${bytes.length} 字节到 ${hex32(a.addr)}${same ? '（回读一致）' : '（⚠ 回读不一致！）'}`, same ? 'ok' : 'err'),
                       ...(same ? [] : hexdump(back, a.addr).map(l => L('  回读 ' + l, 'err')))] };
    }

    case 'ms': {
      need();
      if (args.length < 2) throw new Error('用法：ms <地址> <文本>');
      const a = addrOf(args[0], { session: S });
      const text = rest.slice(rest.indexOf(args[1]));
      const bytes = new TextEncoder().encode(text);
      await S.memWrite(a.addr, bytes);
      return { lines: [L(`写入字符串 ${bytes.length} 字节到 ${hex32(a.addr)}`, 'ok')] };
    }

    case 'p': {
      need();
      if (!args.length) throw new Error('用法：p <变量名>（变量从载入的 .elf 里找）');
      const name = args[0];
      const st = S.sym;
      if (!st) throw new Error('还没载入 .elf —— `p` 需要符号表（先在上面点「载入 ELF…」）');
      const t = st.varType(name);
      if (!t){
        const r = st.resolve(name);
        if (!r) throw new Error(`找不到变量或符号：「${name}」（试试 sym ${name}）`);
        const loc = st.locText?.(r.addr) || '';
        return { lines: [L(`${name} → ${hex32(r.addr)}${r.sym?.size ? `（${r.sym.size} 字节）` : ''}${loc ? '  ' + loc : ''}`, 'dim')] };
      }
      const size = t.scalarInfo ? t.scalarInfo.size : Math.min(t.size || 4, 64);
      const raw = await S.memRead(t.addr, size);
      checkCancel(opts);
      const loc = st.locText?.(t.addr) || '';
      return { lines: [L(fmtVar(t, raw, S) + (loc ? '  ' + loc : ''))] };
    }

    case 'b': case 'break': {
      need();
      if (!args.length) throw new Error('用法：b <地址|符号>（例：b main / b 0x08000123）');
      const a = addrOf(args[0], { session: S });
      const r = await S.bpAdd(a.addr);
      return { lines: [L(`断点 #${r.index + 1} @ ${hex32(a.addr)}${a.sym ? ` (${a.sym.name})` : ''}`, r.warn ? 'warn' : 'ok'),
                       ...(r.warn ? [L('   ' + r.warn, 'warn')] : [])] };
    }

    case 'bd': case 'delete': {
      need();
      if (!args.length) throw new Error('用法：bd <编号|地址|符号|all>');
      if (args[0] === 'all' || args[0] === '*'){
        const n = await S.bpClear();
        return { lines: [L(`已清掉 ${n} 个断点`, 'ok')] };
      }
      const asNum = /^\d+$/.test(args[0]) ? Number(args[0]) : null;
      const list = S.bpList();
      let target = null;
      if (asNum !== null && asNum >= 1 && asNum <= list.length) target = list[asNum - 1];
      else {
        const a = addrOf(args[0], { session: S });
        target = list.find(x => x.addr === a.addr);
      }
      if (!target) throw new Error(`找不到这个断点：「${args[0]}」（bl 看现有哪些）`);
      await S.bpDel(target.addr);
      return { lines: [L(`删掉断点 @ ${hex32(target.addr)}`, 'ok')] };
    }

    case 'bl': case 'breakpoints': {
      const list = S.bpList();
      if (!list.length) return { lines: [L('没有断点（b <地址|符号> 添加）', 'dim')] };
      list.forEach((b, i) => lines.push(L(`  #${i + 1}  ${hex32(b.addr)}${b.sym ? '  ' + b.sym : ''}  比较器 ${b.slot}`, 'ok')));
      const cap = S.caps?.numCode || 0;
      lines.push(L(`共 ${list.length} 个 / 硬件上限 ${cap} 个（FPB rev${S.caps?.rev ?? '?'}）`, 'dim'));
      return { lines };
    }

    case 'info': {
      lines.push(L(infoLine(S)));
      if (S.connected) lines.push(L(statusLine(S)));
      if (S.sym){
        lines.push(L('符号：' + S.sym.summary(), 'dim'));
        if (S.sym.lines) lines.push(L('行号：' + S.sym.lines.summary(), 'dim'));
      }
      return { lines };
    }

    case 'sym': case 'symbols': {
      if (!S.sym) throw new Error('还没载入 .elf');
      if (!args.length) throw new Error('用法：sym <子串>');
      const hits = S.sym.search(args[0]);
      if (!hits.length) return { lines: [L(`没有匹配「${args[0]}」的符号`, 'warn')] };
      for (const h of hits){
        const loc = h.kind === 'func' ? (S.sym.locText?.(h.addr) || '') : '';
        lines.push(L(`  ${h.kind === 'func' ? 'F' : h.kind === 'var' ? 'V' : 'D'} ${hex32(h.addr)} ${String(h.size || 0).padStart(6)}  ${h.name}${h.scalar ? '  : ' + h.scalar : ''}${loc ? '  ' + loc : ''}`));
      }
      lines.push(L(`共 ${hits.length} 条${hits.length >= 40 ? '（只显示前 40 条）' : ''}`, 'dim'));
      return { lines };
    }

    // ---- 监视窗口（w / wl / wd）——「选择 ELF 里的变量，停下来看它的值」 ----
    case 'w': case 'watch': {
      if (!V?.addWatch) throw new Error('监视窗口需要界面支持（`w` 只在调试器页可用）');
      if (!rest.trim()) throw new Error('用法：w <变量名|符号+偏移|0x地址>（例：w g_tick / w g_buf+4 / w 0x20000000）');
      const expr = rest.trim();
      const r = V.addWatch(expr);
      if (r?.error) throw new Error(r.error);
      if (r?.dup) return { lines: [L(`监视里已经有「${expr}」了`, 'warn')] };
      const it = r?.item;
      return { lines: [L(`监视 + ${expr}${it?.addr !== undefined ? ' @ ' + hex32(it.addr) : ''}${it?.error ? '　⚠ ' + it.error : ''}`, it?.error ? 'warn' : 'ok')] };
    }

    case 'wl': case 'watchlist': {
      if (!V) throw new Error('监视窗口需要界面支持');
      const items = V.watchItems ? V.watchItems() : (V.watch?.items || []);
      if (!items.length) return { lines: [L('监视是空的（w <变量> 加一项）', 'dim')] };
      items.forEach((it, i) => {
        const val = it.error ? '⚠ ' + it.error : (it.value?.text ?? '（还没读）');
        lines.push(L(`  #${i + 1}  ${String(it.label || it.expr).padEnd(18, ' ')} ${it.addr !== undefined ? hex32(it.addr) : '          '}  = ${val}${it.value?.hex && !String(val).includes(it.value.hex) ? ' (' + it.value.hex + ')' : ''}`,
          it.error ? 'warn' : 'ok'));
      });
      lines.push(L(`共 ${items.length} 项 —— 停止（暂停/命中/单步）时自动刷新；运行中刷新看侧栏那个开关`, 'dim'));
      return { lines };
    }

    case 'wd': case 'unwatch': {
      if (!V?.delWatch) throw new Error('监视窗口需要界面支持');
      if (!args.length) throw new Error('用法：wd <编号|名字|all>（编号见 wl）');
      const r = V.delWatch(args[0]);
      if (!r?.removed) throw new Error(`找不到这个监视项：「${args[0]}」（wl 看现有哪些）`);
      return { lines: [L(`已删掉 ${r.removed} 项监视`, 'ok')] };
    }

    // ---- 源码位置（sl / src）----
    case 'sl': {
      need();
      if (!S.sym) throw new Error('还没载入 .elf');
      if (!S.sym.lines) throw new Error('这份 ELF 没有行号信息（编译时没带 -g，或被 strip 过）');
      const pc = S.pc >>> 0;
      const at = S.sym.at(pc & 0xfffffffe);
      if (!at) return { lines: [L(`PC ${hex32(pc)} 不在有行号信息的代码里（可能在库函数/启动代码）`, 'warn')] };
      lines.push(L(`${at.file}:${at.line}${at.col ? ':' + at.col : ''}  ←  PC ${hex32(pc)} ${S.sym.nameOf(pc)}`, 'ok'));
      if (V?.showSource) await V.showSource(at.file, at.line);
      return { lines };
    }

    case 'src': {
      if (!S.sym) throw new Error('还没载入 .elf');
      if (!S.sym.lines) throw new Error('这份 ELF 没有行号信息（编译时没带 -g，或被 strip 过）');
      const arg = args[0] || '';
      if (!arg){
        const paths = S.sym.lines.paths.slice(0, 40);
        if (!paths.length) return { lines: [L('行号表里没有源文件（这份 ELF 只有汇编？）', 'warn')] };
        lines.push(L(`行号表里的源文件（${S.sym.lines.fileCount} 个，列前 ${paths.length} 个）：`, 'dim'));
        for (const p of paths) lines.push(L('  ' + p));
        lines.push(L('用法：src <文件:行> 把源码视图跳过去（文件名可以只写后几段，例如 src main.c:120）', 'dim'));
        return { lines };
      }
      const m = /^(.*?):(\d+)$/.exec(arg);
      const file = m ? m[1] : arg;
      const line = m ? Number(m[2]) : 1;
      if (V?.showSource){
        const ok = await V.showSource(file, line);
        if (!ok) throw new Error(`行号表里没有这个文件：「${file}」（src 不带参数可以列出全部）`);
        return { lines: [L(`源码视图跳到 ${file}:${line}`, 'ok')] };
      }
      lines.push(L(`这个命令需要界面支持`, 'warn'));
      return { lines };
    }

    default:
      throw new Error(`不认识的命令：「${cmd}」（h 看帮助）`);
  }
}

// ---------------------------------------------------------------- 格式化

const normName = info => (info.name || '').toUpperCase();
const regLabel = info => normName(info).padEnd(9, ' ');

/** 一行寄存器（含符号落点与 xPSR 拆解） */
function fmtReg(r, S){
  const v = r.value >>> 0;
  const name = normName(r);
  let extra = '';
  if (name === 'PC' || name === 'LR'){
    const f = S?.sym?.funcAt?.(v & ~1);
    if (f) extra = `  →  ${f.name}+0x${f.off.toString(16)}${f.exact ? '' : '(?)'}`;
    else if (v >= 0x1fff0000 && v < 0x20000000) extra = '  →  ⚠ 系统存储器（ROM bootloader）—— 板子可能是在 BOOT0=1 下启动的';
  } else if (name === 'XPSR') extra = '  ' + formatXpsr(v);
  else if (name === 'SP' || name === 'MSP' || name === 'PSP') extra = (v & 3) ? '  ⚠ 不是 4 字节对齐' : '';
  else if (r.kind === 'cfbp') extra = '  ' + formatSpecial(name, v & 0xff);
  return `${regLabel(r)}  ${hex32(v)}${extra}`;
}

/** 只取某个寄存器的那一行（`s` 命令回显用） */
function regLine(S, which){
  const r = S.regList().find(x => normName(x) === which);
  return r ? fmtReg(r, S) : '';
}

function statusLine(S){
  const st = S.statusInfo ? S.statusInfo() : { halted: S.halted, pc: 0 };
  const pc = st.pc >>> 0;
  const f = S?.sym?.funcAt?.(pc & ~1);
  return `状态：${st.halted ? '已停止（halted）' : '运行中'}　PC=${hex32(pc)}${f ? ` ${f.name}+0x${f.off.toString(16)}` : ''}`;
}

function infoLine(S){
  if (!S.connected) return '未连接（后端：' + (S.backendName || '—') + '）';
  return `后端：${S.name || 'CMSIS-DAP'}　SWD ${S.clockHz ? (S.clockHz / 1000) + ' MHz' : '默认'}　`
       + `IDCODE=0x${(S.idcode >>> 0).toString(16).toUpperCase()}`;
}

/** 一个变量的显示（有类型就解数值，没有就把字节摆出来） */
function fmtVar(t, raw, S){
  const base = `${t.name} @ ${hex32(t.addr)}`;
  const ty = t.scalar || t.typeName || (t.size ? `${t.size} 字节` : '?');
  if (t.scalarInfo && raw.length >= t.scalarInfo.size){
    const v = decodeScalar(t.scalar, raw);
    const hex = '0x' + (t.scalarInfo.size > 4 ? readLE(raw, 0, t.scalarInfo.size).toString(16) : (v >>> 0).toString(16));
    return `${base}  :  ${ty} = ${v}${t.scalar === 'f32' || t.scalar === 'f64' ? '' : '  (' + hex + ')'}`;
  }
  if (raw.length <= 8){
    return `${base}  :  ${ty} = ${[...raw].map(hex8).join(' ')}  (${readLE(raw, 0, raw.length)} = 0x${readLE(raw, 0, raw.length).toString(16)})`;
  }
  const head = [...raw.subarray(0, 16)].map(hex8).join(' ');
  return `${base}  :  ${ty}（共 ${t.size} 字节，前 16 字节）= ${head} …`;
}

/** 按 SCALARS 的名字解码（u8/i8/u16/i16/u32/i32/f32/f64） */
export function decodeScalar(scalar, bytes){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  switch (scalar){
    case 'u8': return dv.getUint8(0);
    case 'i8': return dv.getInt8(0);
    case 'u16': return dv.getUint16(0, true);
    case 'i16': return dv.getInt16(0, true);
    case 'u32': return dv.getUint32(0, true);
    case 'i32': return dv.getInt32(0, true);
    case 'f32': return dv.getFloat32(0, true);
    case 'f64': return dv.getFloat64(0, true);
    default: return readLE(bytes, 0, Math.min(4, bytes.length));
  }
}

/** 特殊寄存器的行（寄存器表用；CFBP 一次读回来拆成 4 行） */
export function specialRows(cfbpValue){
  return SPECIAL_REGS.map(s => ({
    name: s.name, value: cfbpGet(cfbpValue, s.name) >>> 0, shift: s.shift, kind: 'cfbp', note: s.note,
  }));
}

export { decodeXpsr };
