#!/usr/bin/env node
/**
 * tools/dev/panel-json-to-c.mjs —— 把「屏初始化 dump JSON」转成能直接用的 **C 数组**。
 *
 * 源：`E:\esp-idf-wsh\资料\panel_init\dumps\<id>.json`（共 44 份，从 SiFli-SDK 的
 *     `customer/peripherals/*\/*.c` 提取；行格式 `[cmd, [data...]]`，表内**不含延时** ——
 *     dump 只另外记了 `lcd_writereg_count` / `hal_delay_count` / `hal_delayus_count` 三个计数）。
 * 出：带来源注释的 `static const` 表，格式与网页「SPI/QSPI 屏」页『面板初始化』大框吃的
 *     C 数组完全一致（`{cmd, (uint8_t[]){...}, len, delay}`）—— **整段贴进页面就能解析**。
 *
 * 用法：
 *   node tools/dev/panel-json-to-c.mjs gc9a01                    # 默认写到 samples/panel-init/
 *   node tools/dev/panel-json-to-c.mjs gc9a01 --note="常见 1.28 吋 240×240 圆屏"
 *   node tools/dev/panel-json-to-c.mjs --all                     # 44 份全导（给别的屏用）
 *   node tools/dev/panel-json-to-c.mjs <dump.json> --out=xx.h --symbol=yy_init_cmds --type=lcd_init_cmd_t
 *
 * 选项：--dumps=<目录>（默认上面的路径）· --out=<文件> · --symbol=<数组名> · --type=<元素类型名>
 *       --note=<补充说明，可重复> · --all
 */
import fs from 'node:fs';
import path from 'node:path';

const DUMPS_DEFAULT = 'E:\\esp-idf-wsh\\资料\\panel_init\\dumps';
const OUT_DIR_DEFAULT = path.join('samples', 'panel-init');
const argv = process.argv.slice(2);
const opt = (k, d = null) => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const notes = argv.filter(x => x.startsWith('--note=')).map(x => x.split('=').slice(1).join('='));
const ALL = argv.includes('--all');
const dumpsDir = opt('dumps', DUMPS_DEFAULT);

const hex2 = v => '0x' + (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
const cfgText = j => (j.configs || []).map(c =>
  `${c.name || '?'}: ${c.itf || '?'}${c.freq ? ` · ${(c.freq / 1e6).toFixed(c.freq % 1e6 ? 1 : 0)} MHz` : ''}${c.color_mode ? ` · ${c.color_mode}` : ''}`
).join('\n *           ');

/** 一个 dump → 一份 C 头文件文本 + 统计 */
function render(j, { symbol, type, extraNotes = [], srcPath }) {
  const tables = j.tables || [];
  if (!tables.length) throw new Error(`${j.id}: 这个 dump 里没有 tables`);
  const lines = [];
  let rows = 0, params = 0, delays = 0;

  lines.push('/*');
  lines.push(` * ${(j.id || '?').toUpperCase()} 初始化序列 —— **由脚本生成，别手改**`);
  lines.push(' *');
  lines.push(` *   生成器: tools/dev/panel-json-to-c.mjs`);
  lines.push(` *   来源  : ${srcPath}`);
  lines.push(` *           提取自 SiFli-SDK 的 ${j.file || '?'}`);
  if (j.registered_name) lines.push(` *           （该驱动在 SDK 里的注册名是 ${j.registered_name}）`);
  if ((j.configs || []).length) lines.push(` *   接口  : ${cfgText(j)}`);
  lines.push(` *   分辨率: ${j.res_w && j.res_h ? `${j.res_w}×${j.res_h}` : 'dump 里为 null（取自板级宏）—— 别当成已知值'}`);
  lines.push(` *   规模  : 命令 ${tables.reduce((s, t) => s + t.rows.length, 0)} 条` +
             `（dump 自报 row_count ${tables.map(t => t.row_count).join('/')}）`);
  if (j.lcd_writereg_count != null || j.hal_delay_count != null) {
    lines.push(` *           dump 另记：表外 LCD_WriteReg ${j.lcd_writereg_count ?? '?'} 次 · ` +
               `HAL_Delay ${j.hal_delay_count ?? '?'} 次 · HAL_Delay_us ${j.hal_delayus_count ?? '?'} 次`);
  }
  lines.push(' *');
  lines.push(' * ⚠️ 表内**没有延时项**，也**不含** 0x11（sleep out）/ 0x29（display on）——');
  lines.push(' *    SDK 驱动把它们写在初始化表**外面**。上屏前自己补：0x11 → 等 ≥120 ms → 0x29；');
  lines.push(' *    IPS 圆屏模块（GC9A01 那类）通常还要先发 0x21 开反显，颜色才正。');
  for (const n of extraNotes) lines.push(` * ⚠️ ${n}`);
  lines.push(' *');
  lines.push(' * 格式: {cmd, data, data_bytes, delay_ms} —— delay 是**该命令之后**的延时。');
  lines.push(' * 用法: 整段贴进网页「SPI/QSPI 屏」页的『面板初始化』大框即可解析（本来就是 C 数组）。');
  lines.push(' */');

  for (const t of tables) {
    const sym = tables.length > 1 ? `${symbol}_${t.name}`.replace(/[^\w]/g, '_') : symbol;
    lines.push(`// ${t.name}：${t.rows.length} 条`);
    lines.push(`static const ${type} ${sym}[] = {`);
    for (const r of t.rows) {
      const cmd = (Array.isArray(r) ? r[0] : r) | 0;
      const data = Array.isArray(r?.[1]) ? r[1].map(x => x & 0xff) : [];
      const delay = typeof r?.[2] === 'number' ? r[2] | 0 : 0;   // 防御：有的 dump 可能把延时放第三项
      rows++; params += data.length; if (delay) delays++;
      lines.push(`    {${hex2(cmd)}, ${data.length ? `(uint8_t[]){${data.map(hex2).join(', ')}}` : 'NULL'}, ${data.length}, ${delay}},`);
    }
    lines.push('};');
  }
  lines.push('');
  return { text: lines.join('\n'), rows, params, delays };
}

const mkdirp = d => fs.mkdirSync(d, { recursive: true });

function one(idOrPath) {
  const p = idOrPath.endsWith('.json') ? idOrPath : path.join(dumpsDir, `${idOrPath}.json`);
  if (!fs.existsSync(p)) throw new Error(`找不到 dump：${p}`);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const id = j.id || path.basename(p, '.json');
  const out = opt('out') || path.join(OUT_DIR_DEFAULT, `${id}_init_cmds.h`);
  const r = render(j, {
    symbol: opt('symbol', `${id}_init_cmds`),
    type: opt('type', 'lcd_init_cmd_t'),
    extraNotes: notes,
    srcPath: p,
  });
  mkdirp(path.dirname(out));
  fs.writeFileSync(out, r.text, 'utf8');
  console.log(`✓ ${out}`);
  console.log(`   ${r.rows} 条命令 · 参数 ${r.params} B · 带延时 ${r.delays} 条` +
              `${j.row_count && j.row_count !== r.rows ? ` （⚠️ dump 自报 row_count=${j.row_count}）` : ''}`);
  return out;
}

if (ALL) {
  const ids = fs.readdirSync(dumpsDir).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));
  console.log(`全量导出 ${ids.length} 份 → ${OUT_DIR_DEFAULT}\\`);
  let ok = 0, bad = 0;
  for (const id of ids) {
    try { one(id); ok++; } catch (e) { console.log(`✗ ${id}: ${e.message}`); bad++; }
  }
  console.log(`\n完成：成功 ${ok} · 失败 ${bad}`);
} else {
  const target = argv.find(a => !a.startsWith('--'));
  if (!target) {
    console.log('用法：node tools/dev/panel-json-to-c.mjs <id|dump.json> [--out=…] [--symbol=…] [--type=…] [--note=…]');
    console.log('      node tools/dev/panel-json-to-c.mjs --all');
    process.exit(1);
  }
  one(target);
}
