/**
 * 面板初始化代码 → 步骤表（纯函数，Node 自测直接打）。
 *
 * **主打 C 数组**（就是 `axs15352_init_cmds.h` / `st77916_init_cmds_ch32.h` 那种）：
 *
 *     {0xCE, (uint8_t[]){0x5A, 0xA5}, 2, 0},
 *     {0x11, NULL, 0, 100},
 *
 * 顺带认（成本很低，而且你手上很可能出现这几种形态）：
 *   · 纯文本行：`CE 5A A5` / `0xF0 0x28` / 行尾 `10ms`、`delay 100`
 *   · JSON：`[{cmd,data,delay}]`、`{cmd,params,delayMs}`、`{rows:[...]}`（也吃本页自己导出的格式）
 *
 * 两条纪律：
 *   1. **宁可报错也不猜**：解析不了的行进 `errors`（带行号与原文），不静默丢；
 *   2. **长度以实际字节为准**：`{...}` 里自报的 `n` 与真字节数不符时，用真字节数 + 报一条 warning。
 */
import { F, T, stepPayload } from './protocol.js';
import { PANEL_DATA, PANEL_KEYS } from './panels-data.js';

export { PANEL_DATA, PANEL_KEYS };

/** 面板步骤：{ cmd, data:Uint8Array, delayMs, line, raw } */
export const panelStats = rows => ({
  rows: rows.length,
  paramsBytes: rows.reduce((n, r) => n + r.data.length, 0),
  delayMs: rows.reduce((n, r) => n + (r.delayMs | 0), 0),
});

// ============================================================================
// 词法小工具（都保留换行，行号才准）
// ============================================================================

/** 去注释：内容换成空格，**换行原样保留**（行号不能乱）*/
export function stripComments(text){
  let out = '', i = 0;
  const s = String(text ?? '');
  while (i < s.length){
    const c = s[i], n = s[i + 1];
    if (c === '/' && n === '/'){ while (i < s.length && s[i] !== '\n'){ out += ' '; i++; } continue; }
    if (c === '/' && n === '*'){ out += '  '; i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')){ out += (s[i] === '\n' ? '\n' : ' '); i++; } out += '  '; i += 2; continue; }
    if (c === '#' && (i === 0 || s[i - 1] === '\n')){ while (i < s.length && s[i] !== '\n'){ out += ' '; i++; } continue; }   // #pragma / #include 也算注释
    out += c; i++;
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** 按顶层分隔符切（跟踪 {} () [] 与字符串）—— C 数组元素里有嵌套的 {}，不能直接 split */
export function topLevelSplit(str, sep = ','){
  return splitWithPos(str, sep).map(x => x.text);
}

/** 同上，但把每段的起始偏移也带出来（行号要准）*/
function splitWithPos(str, sep = ','){
  const parts = [];
  let depth = 0, start = 0, quote = null;
  for (let i = 0; i < str.length; i++){
    const c = str[i];
    if (quote){ if (c === '\\'){ i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'"){ quote = c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0){ parts.push({ text: str.slice(start, i), start }); start = i + 1; }
  }
  parts.push({ text: str.slice(start), start });
  return parts;
}

const HEX = /^0x[0-9a-f]+$/i;
/** `0x1F` / `31` → 数字；不是数字返回 null */
export function parseNum(s){
  const t = String(s ?? '').trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (HEX.test(t)) return parseInt(t, 16);
  return null;
}

/** 一段文本里所有的字节字面量（`0x5A, 0xA5` / `5A A5` 都认）*/
function bytesIn(s){
  const out = [];
  const re = /0x([0-9a-f]{1,2})\b/gi;
  let m;
  while ((m = re.exec(s))) out.push(parseInt(m[1], 16) & 0xff);
  if (!out.length){
    const plain = String(s).match(/\b[0-9a-f]{1,2}\b/gi) || [];
    for (const p of plain){ if (/^[0-9a-f]{1,2}$/i.test(p)) out.push(parseInt(p, 16) & 0xff); }
  }
  return out;
}

// ============================================================================
// 主解析
// ============================================================================

/**
 * @returns {{rows:Array, errors:Array, warnings:Array, stats:object, format:string}}
 */
export function parsePanelCode(text){
  const raw = String(text ?? '');
  if (!raw.trim()) return { rows: [], errors: [], warnings: [], stats: panelStats([]), format: 'empty' };

  const clean = stripComments(raw);

  // ① JSON（整段能被 JSON.parse 就当 JSON 处理：比 C 扫描更精确）
  const trimmed = clean.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')){
    try {
      const j = JSON.parse(trimmed);
      const arr = Array.isArray(j) ? j : (Array.isArray(j.rows) ? j.rows : (Array.isArray(j.steps) ? j.steps : null));
      if (arr && arr.length && (arr[0].cmd !== undefined || arr[0].command !== undefined)){
        return fromArray(arr);
      }
    } catch { /* 不是 JSON，继续走 C 扫描 */ }
  }

  // ② C 数组：先判断"整段外层是不是一对包住多个元素的括号"，再切元素
  const elems = elementsOf(clean);
  if (elems.length) return fromCElements(elems);

  // ③ 纯文本行
  const textRows = fromTextLines(clean);
  if (textRows.rows.length || textRows.errors.length) return textRows;

  return {
    rows: [], warnings: [],
    errors: [{ line: 1, text: raw.split('\n')[0].slice(0, 80), why: '没认出任何初始化条目（支持 C 数组 / 纯文本行 / JSON）' }],
    stats: panelStats([]), format: 'unknown',
  };
}

/**
 * 抠出所有顶层元素 `{...}`。
 *
 * 麻烦在于"贴进来的东西"形态不止一种：
 *   (a) 带数组壳：`static const T x[] = { {A}, {B} };`        ← 头文件里就是这种
 *   (b) 无壳的多元素：`{A},\n{B},`                            ← 我们自己导出的 C 片段是这种
 *   (c) 单个元素：`{0xCE, (uint8_t[]){0x5A, 0xA5}, 2, 0},`
 * 判据：**最外层那对括号的顶层分隔里，有没有以 `{` 开头的段** ——
 *   · 有 → 那是容器，钻进去取元素；
 *   · 没有 → 整段本身就是元素列表（(b)/(c)）。
 * 直接用"花括号深度"判会错：(c) 里的 `(uint8_t[]){...}` 也是嵌套括号。
 */
function elementsOf(clean){
  const outer = outermostBraces(clean);
  if (outer){
    const inner = clean.slice(outer.start, outer.end);
    const looksLikeList = splitWithPos(inner, ',').some(seg => seg.text.trim().startsWith('{'));
    if (looksLikeList) return listElements(inner, outer.start, clean);
  }
  return listElements(clean, 0, clean);
}

/** 第一对"从第一个 `{` 到它配对的 `}`"，返回其内部区间；没有括号返回 null */
function outermostBraces(clean){
  const first = clean.indexOf('{');
  if (first < 0) return null;
  let depth = 0;
  for (let i = first; i < clean.length; i++){
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}'){ depth--; if (depth === 0) return { start: first + 1, end: i }; }
  }
  return { start: first + 1, end: clean.length };
}

/** 在给定片段里按顶层逗号切，取出形如 `{...}` 的元素（行号按原文算）*/
function listElements(segment, baseOffset, clean){
  const baseLine = lineOf(clean, baseOffset);
  const out = [];
  for (const seg of splitWithPos(segment, ',')){
    const t = seg.text.trim();
    if (!t.startsWith('{')) continue;                 // 声明/残留文字，跳过
    let depth = 0, end = -1;
    for (let i = 0; i < t.length; i++){
      if (t[i] === '{') depth++;
      else if (t[i] === '}'){ depth--; if (depth === 0){ end = i; break; } }
    }
    const inner = end >= 0 ? t.slice(1, end) : t.slice(1);
    // 行号：从"段的第一行"起算，再加上段内第一个非空白字符之前那几行
    const lead = seg.text.length - seg.text.trimStart().length;
    const line = baseLine + (segment.slice(0, seg.start + lead).split('\n').length - 1);
    out.push({ inner, line: Math.max(1, line), raw: t.slice(0, end + 1) });
  }
  return out;
}

/** C 元素 → 行。字段形态：{cmd, (uint8_t[]){...}, n, delay} / {cmd, NULL, 0, delay} / {cmd, data, delay} */
function fromCElements(elems){
  const rows = [], errors = [], warnings = [];
  for (const el of elems){
    const f = topLevelSplit(el.inner, ',').map(x => x.trim());
    if (!f.length || !f[0]) continue;
    const cmd = parseNum(f[0]);
    if (cmd == null || cmd < 0 || cmd > 255){
      errors.push({ line: el.line, text: el.raw.slice(0, 80), why: `命令字不是 0~255 的字节：'${f[0].slice(0, 24)}'` });
      continue;
    }
    // 数据：优先带 {} / [] 的那个字段；否则第 2 个字段若是字节串也认
    let data = new Uint8Array(0), lenField = null, delayMs = 0, dataAt = -1;
    for (let i = 1; i < f.length; i++){
      const field = f[i];
      if (/[{[]/.test(field)){ data = Uint8Array.from(bytesIn(field)); dataAt = i; }
      else if (/^(null|NULL|0)$/.test(field) && dataAt < 0){ data = new Uint8Array(0); dataAt = i; }
    }
    for (let i = 1; i < f.length; i++){
      if (i === dataAt) continue;
      const v = parseNum(f[i]);
      if (v == null) continue;
      if (lenField == null && f.length >= 4 && i === dataAt + 1) lenField = v;   // {cmd,data,n,delay}
      else delayMs = v;                                                          // 最后一个数字当延时
    }
    if (lenField != null && lenField !== data.length){
      warnings.push({ line: el.line, text: el.raw.slice(0, 80), why: `自报长度 ${lenField} 与实际 ${data.length} 字节不符 —— 按实际字节发` });
    }
    if (delayMs < 0 || delayMs > 65535){
      warnings.push({ line: el.line, text: el.raw.slice(0, 80), why: `延时 ${delayMs} ms 超出 0~65535，已夹取` });
      delayMs = Math.max(0, Math.min(65535, delayMs));
    }
    rows.push({ cmd, data, delayMs: delayMs | 0, line: el.line, raw: el.raw.slice(0, 120) });
  }
  return { rows, errors, warnings, stats: panelStats(rows), format: 'c' };
}

/** JSON 数组 → 行 */
function fromArray(arr){
  const rows = [], errors = [], warnings = [];
  arr.forEach((it, i) => {
    const cmd = parseNum(it.cmd ?? it.command ?? it.reg);
    if (cmd == null){ errors.push({ line: i + 1, text: JSON.stringify(it).slice(0, 80), why: '缺少 cmd/command 字段' }); return; }
    const src = it.data ?? it.params ?? it.bytes ?? [];
    const data = Uint8Array.from((Array.isArray(src) ? src : []).map(v => (parseNum(v) ?? 0) & 0xff));
    const delayMs = Math.max(0, Math.min(65535, (parseNum(it.delay ?? it.delayMs ?? it.delay_ms) ?? 0) | 0));
    if (it.len !== undefined && parseNum(it.len) !== data.length){
      warnings.push({ line: i + 1, text: JSON.stringify(it).slice(0, 80), why: `自报长度 ${it.len} 与实际 ${data.length} 字节不符 —— 按实际字节发` });
    }
    rows.push({ cmd, data, delayMs, line: i + 1, raw: JSON.stringify(it).slice(0, 120) });
  });
  return { rows, errors, warnings, stats: panelStats(rows), format: 'json' };
}

/** 纯文本行：`CE 5A A5 10ms` / `0xF0 0x28 delay 100` / `11` */
function fromTextLines(clean){
  const rows = [], errors = [];
  const lines = clean.split('\n');
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (!t) return;
    if (/^[{};,]+$/.test(t)) return;                        // 数组残留的括号逗号
    if (/^(static|const|uint8_t|typedef|struct|extern|\w+\s+\w+\s*=|#)/.test(t)) return;  // 声明行
    let s = t, delayMs = 0;
    const mDelay = /(?:delay\s*|@)?(\d+)\s*(ms|us)\s*$/i.exec(s);
    if (mDelay){
      const v = +mDelay[1];
      delayMs = /us/i.test(mDelay[2]) ? Math.round(v / 1000) : v;
      s = s.slice(0, mDelay.index).trim();
    } else {
      const mAt = /@\s*(\d+)\s*$/.exec(s);
      if (mAt){ delayMs = +mAt[1]; s = s.slice(0, mAt.index).trim(); }
    }
    const bytes = bytesIn(s);
    if (!bytes.length) return;                              // 认不出就跳过（不报错：可能是说明文字）
    const [cmd, ...rest] = bytes;
    rows.push({ cmd, data: Uint8Array.from(rest), delayMs: Math.max(0, Math.min(65535, delayMs)), line: i + 1, raw: t.slice(0, 120) });
  });
  const bad = lines.length && !rows.length && !errors.length;
  if (bad){
    const firstNonEmpty = lines.findIndex(l => l.trim());
    errors.push({ line: firstNonEmpty + 1, text: lines[firstNonEmpty].trim().slice(0, 80), why: '这行没有可识别的字节（要 00~FF 的十六进制）' });
  }
  return { rows, errors, warnings: [], stats: panelStats(rows), format: 'text' };
}

// ============================================================================
// 表格 → 线上（STEP 帧）/ 导出
// ============================================================================

/** 一条面板步 → 一个 STEP 帧（按当前面板档在探针侧展开）*/
export function rowToFrame(row, { flags = 0, seq = 0 } = {}){
  return { type: T.STEP, payload: stepPayloadOf(row), flags, seq, label: `STEP 0x${row.cmd.toString(16).padStart(2, '0')}` };
}

const stepPayloadOf = row => stepPayload({ cmd: row.cmd, params: row.data, delayMs: row.delayMs });

/** 步骤表 → 一次 sendFrames 的 items（**只有最后一条带 RSP**：不然 IN 流量会拖慢灌数据）*/
export function rowsToItems(rows, { start = 0, end = rows.length - 1, rspAll = false } = {}){
  const slice = rows.slice(start, end + 1);
  return slice.map((r, i) => ({
    type: T.STEP,
    payload: stepPayloadOf(r),
    flags: (rspAll || i === slice.length - 1) ? F.RSP : 0,
    label: `STEP 0x${r.cmd.toString(16).padStart(2, '0')}${r.data.length ? ` +${r.data.length}B` : ''}`,
  }));
}

const h2 = v => '0x' + (v & 0xff).toString(16).toUpperCase().padStart(2, '0');

/** 导出成能贴回 C 头文件的片段（每个字节都带 0x，不然粘回去编译不过）*/
export function rowsToC(rows){
  return rows.map(r => r.data.length
    ? `    {${h2(r.cmd)}, (uint8_t[]){${[...r.data].map(h2).join(', ')}}, ${r.data.length}, ${r.delayMs}},`
    : `    {${h2(r.cmd)}, NULL, 0, ${r.delayMs}},`).join('\n');
}

export function rowsToJson(rows){
  return JSON.stringify({
    _what: 'SPI/QSPI 屏 · 面板初始化步骤',
    rows: rows.map(r => ({ cmd: r.cmd, data: [...r.data], delay: r.delayMs })),
  }, null, 1);
}

/** 导出成纯文本（每行一条，行尾带延时）—— 人看的，也能再贴回来 */
export function rowsToText(rows){
  return rows.map(r => `${h2(r.cmd)}${r.data.length ? ' ' + [...r.data].map(v => v.toString(16).toUpperCase().padStart(2, '0')).join(' ') : ''}` +
    (r.delayMs ? `  ${r.delayMs}ms` : '')).join('\n');
}
