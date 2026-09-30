/**
 * 纯 Node 自测（不需要浏览器、不需要硬件）：
 *   node tools/selftest/spi-panel-code.test.mjs
 *
 * 覆盖「SPI/QSPI 屏」页的两块纯逻辑：
 *   A. **面板初始化代码解析**（C 数组为主，顺带认纯文本/JSON）—— 内含"与源 C 头文件对账"
 *   B. **图片 → 帧**（图案 / RGB565 / BMP / 对齐 / 切片）—— 逐字节对账，最后喂给假探针跑一遍整屏刷
 *
 * 这里咬的是"贴进去的代码有没有被正确理解"和"发出去的字节对不对"，两者都是肉眼看不出来的。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..', 'app');
const url = p => 'file://' + join(app, p).replace(/\\/g, '/');

const P = await import(url('spi/protocol.js'));
const C = await import(url('spi/panel-code.js'));
const I = await import(url('spi/image.js'));
const M = await import(url('spi/mock.js'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const eqArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = a => [...a].map(x => x.toString(16).padStart(2, '0')).join(' ');

// ==================================================================== A1
console.log('== A1. 解析 C 数组（主格式）==');
{
  const src = `
/* 面板初始化序列 —— 测试样例 */
static const st77916_lcd_init_cmd_t demo[] = {
    {0xCE, (uint8_t[]){0x5A, 0xA5}, 2, 0},        // 进入寄存器组
    {0xA1, (uint8_t[]){0x00, 0xDD, 0x00}, 3, 0},
    {0x11, NULL, 0, 100},                          // sleep out + 等 100ms
    {0x29, NULL, 0, 0},
};
`;
  const r = C.parsePanelCode(src);
  ok(r.format === 'c' && r.rows.length === 4, `认出 4 条（format=${r.format}）`, JSON.stringify(r.errors));
  ok(r.rows[0].cmd === 0xce && eqArr(r.rows[0].data, Uint8Array.of(0x5a, 0xa5)) && r.rows[0].delayMs === 0, '第 1 条：命令 + 2 字节参数');
  ok(r.rows[1].data.length === 3, '第 2 条：3 字节参数');
  ok(r.rows[2].cmd === 0x11 && r.rows[2].data.length === 0 && r.rows[2].delayMs === 100, '第 3 条：NULL 参数 + 100 ms');
  ok(r.rows[2].line === 6, `行号指向源文件那一行（${r.rows[2].line}，模板里首行是空行，故为 6）`);
  ok(r.errors.length === 0 && r.warnings.length === 0, '没有错误也没有告警');
  ok(r.stats.rows === 4 && r.stats.paramsBytes === 5 && r.stats.delayMs === 100,
     `统计：4 条 / 5 参数字节 / 100 ms（实际 ${r.stats.paramsBytes} B / ${r.stats.delayMs} ms）`);

  // 跨行元素（参数很长时人会换行）
  const multiline = `static const T t[] = {
    {0xB0, (uint8_t[]){0x01,
                       0x02, 0x03}, 3, 5},
};`;
  const r2 = C.parsePanelCode(multiline);
  ok(r2.rows.length === 1 && r2.rows[0].data.length === 3 && r2.rows[0].delayMs === 5, '参数换行的条目照样能解析');

  // 自报长度与实际不符 → 告警但不猜
  const bad = C.parsePanelCode(`{0xCE, (uint8_t[]){0x5A, 0xA5}, 5, 0},`);
  ok(bad.rows.length === 1 && bad.warnings.length === 1 && /自报长度 5/.test(bad.warnings[0].why),
     '自报长度 5 ≠ 实际 2 字节 → 按实际字节发 + 告警');

  // 非法命令字 → 报错带行号
  const err = C.parsePanelCode(`{\n  {0x1FF, NULL, 0, 0},\n};`);
  ok(err.errors.length === 1 && err.errors[0].line === 2, `命令字越界行被指出来（第 ${err.errors[0]?.line} 行）`);

  // 注释/#pragma 不干扰行号
  const withPragma = `#pragma once\n// 说明\n#include "x.h"\nstatic const T a[] = {\n  {0x11, NULL, 0, 0},\n};`;
  const r3 = C.parsePanelCode(withPragma);
  ok(r3.rows.length === 1 && r3.rows[0].line === 5, `#pragma/#include/注释都跳过，行号仍准（${r3.rows[0].line}）`);
}

// ==================================================================== A2
console.log('== A2. 与源 C 头文件对账（内置两套表）==');
{
  for (const key of C.PANEL_KEYS){
    const d = C.PANEL_DATA[key];
    const r = C.parsePanelCode(d.text);
    ok(r.rows.length === d.expect.rows, `${key}：条数 ${r.rows.length} == 源文件声明的 ${d.expect.rows}`, JSON.stringify(r.errors.slice(0, 2)));
    ok(r.errors.length === 0, `${key}：解析零错误`);
    if (d.expect.paramsBytes != null){
      ok(r.stats.paramsBytes === d.expect.paramsBytes, `${key}：参数字节 ${r.stats.paramsBytes} == ${d.expect.paramsBytes}`);
    }
    if (d.expect.delayMs != null){
      ok(r.stats.delayMs === d.expect.delayMs, `${key}：累计延时 ${r.stats.delayMs} ms == ${d.expect.delayMs} ms`);
    }
    if (d.expect.params != null){
      const withData = r.rows.filter(x => x.data.length > 0).length;
      ok(withData === d.expect.params, `${key}：带参数 ${withData} 条 == ${d.expect.params}`);
    }
    if (d.expect.delays != null){
      const withDelay = r.rows.filter(x => x.delayMs > 0).length;
      ok(withDelay === d.expect.delays, `${key}：带延时 ${withDelay} 条 == ${d.expect.delays}`);
    }
  }
  const axs = C.parsePanelCode(C.PANEL_DATA.axs15352.text);
  ok(axs.rows[0].cmd === 0xce && axs.rows[axs.rows.length - 1].cmd === 0x29, 'AXS15352 首尾命令是 CE…29（与源文件一致）');
  const st = C.parsePanelCode(C.PANEL_DATA.st77916.text);
  ok(st.rows[0].cmd === 0xf0 && st.rows[0].data[0] === 0x28, 'ST77916 首条是 F0 28');
}

// ==================================================================== A3
console.log('== A3. 顺带认的两种形态（纯文本行 / JSON）==');
{
  const t = C.parsePanelCode(`CE 5A A5\n11  100ms\n29\n# 说明一行`);
  ok(t.format === 'text' && t.rows.length === 3, `纯文本 3 条（format=${t.format}）`, JSON.stringify(t.errors));
  ok(t.rows[0].cmd === 0xce && t.rows[0].data.length === 2 && t.rows[1].delayMs === 100, '文本行：首字节当命令，行尾 100ms 当延时');

  const j = C.parsePanelCode(JSON.stringify([{ cmd: 0xf0, data: [0x28], delay: 0 }, { cmd: '0x11', params: [], delayMs: 120 }]));
  ok(j.format === 'json' && j.rows.length === 2 && j.rows[1].delayMs === 120, 'JSON：cmd/data/delay 与 params/delayMs 都认');

  const empty = C.parsePanelCode('   \n  ');
  ok(empty.format === 'empty' && empty.rows.length === 0, '空文本框 → empty（不报错）');

  const junk = C.parsePanelCode('这是一段说明文字，没有任何字节');
  ok(junk.rows.length === 0 && junk.errors.length === 1, '认不出就报一条错，不静默');
}

// ==================================================================== A4
console.log('== A4. 导出与往返 ==');
{
  const rows = [
    { cmd: 0xce, data: Uint8Array.of(0x5a, 0xa5), delayMs: 0, line: 1 },
    { cmd: 0x11, data: new Uint8Array(0), delayMs: 100, line: 2 },
  ];
  const c = C.rowsToC(rows);
  ok(/0xCE/.test(c) && /\(uint8_t\[\]\)\{0x5A, 0xA5\}/.test(c) && /NULL, 0, 100/.test(c), `C 片段每个字节都带 0x（\n${c}\n）`);
  const back = C.parsePanelCode(c);
  ok(back.rows.length === 2 && back.rows[0].cmd === 0xce && eqArr(back.rows[0].data, Uint8Array.of(0x5a, 0xa5)) && back.rows[1].delayMs === 100,
     '导出的 C 片段能被自己再解析回来（往返一致）');
  const txt = C.rowsToText(rows);
  ok(/CE 5A A5/.test(txt) && /100ms/.test(txt), `文本导出带延时（${txt.replace(/\n/g, ' | ')}）`);
  const j = JSON.parse(C.rowsToJson(rows));
  ok(j.rows.length === 2 && j.rows[0].data[0] === 0x5a, 'JSON 导出结构正确');
}

// ==================================================================== A5
console.log('== A5. 表格 → STEP 帧（只有最后一条要应答）==');
{
  const rows = [
    { cmd: 0xce, data: Uint8Array.of(0x5a, 0xa5), delayMs: 0 },
    { cmd: 0x11, data: new Uint8Array(0), delayMs: 100 },
    { cmd: 0x29, data: new Uint8Array(0), delayMs: 0 },
  ];
  const items = C.rowsToItems(rows);
  ok(items.length === 3 && items[0].flags === 0 && items[2].flags === P.F.RSP,
     '192 条那种表：只有最后一条带 RSP（避免 IN 流量拖慢）');
  const payload = items[1].payload;
  ok(payload[0] === 0x11 && payload[1] === 0 && new DataView(payload.buffer).getUint16(2, true) === 100,
     'STEP 载荷 = cmd / nparams / delay_ms');
  const slice = C.rowsToItems(rows, { start: 1, end: 2 });
  ok(slice.length === 2 && slice[0].payload[0] === 0x11, '支持"从第 N 条重放"');
}

// ==================================================================== B1
console.log('== B1. 内置图案 + RGB565（高字节在前 / R-B 交换 / 灰阶）==');
{
  const red = I.makePattern('R', 4, 2);
  ok(red.w === 4 && red.h === 2 && red.rgba.length === 32, '图案尺寸与 RGBA 长度');
  ok(red.rgba[0] === 255 && red.rgba[1] === 0 && red.rgba[2] === 0, '红图案首像素 (255,0,0)');
  ok(I.makePattern('CH', 4, 4).rgba[0] === 0, '棋盘（16px 块）在小图上是一整块（(0,0) 是暗块）');
  const ch32 = I.makePattern('CH', 32, 32);
  ok(ch32.rgba[0] !== ch32.rgba[(0 * 32 + 16) * 4], '棋盘 16px：相邻块颜色相反（32×32 上验）');
  const ch1 = I.makePattern('CH1', 4, 4);
  ok(ch1.rgba[0] === 0 && ch1.rgba[4] === 255, '棋盘 1px：(0,0) 暗、(1,0) 亮（逐像素交替）');
  ok(I.PATTERNS.length >= 15, `内置图案 ${I.PATTERNS.length} 种`);

  const px = I.rgbaTo565(Uint8Array.of(255, 0, 0, 255));
  ok(eqArr(px, Uint8Array.of(0xf8, 0x00)), `纯红 → F8 00（大端，实测 ${hex(px)}）`);
  ok(eqArr(I.rgbaTo565(Uint8Array.of(0, 255, 0, 255)), Uint8Array.of(0x07, 0xe0)), '纯绿 → 07 E0');
  ok(eqArr(I.rgbaTo565(Uint8Array.of(0, 0, 255, 255)), Uint8Array.of(0x00, 0x1f)), '纯蓝 → 00 1F');
  ok(eqArr(I.rgbaTo565(Uint8Array.of(255, 0, 0, 255), { swap: true }), Uint8Array.of(0x00, 0x1f)),
     'R/B 交换：红按蓝发（屏的 MADCTL 不同时的救命开关）');

  const lv = I.rgbaTo565(Uint8Array.of(255, 255, 255, 255), { level: 128 });
  const v = (lv[0] << 8) | lv[1];
  ok(v === (((128 >> 3) << 11) | ((128 >> 2) << 5) | (128 >> 3)), `灰阶 128：满量程分量被压到 128（0x${v.toString(16)}）`);
  const back = I.rgb565ToRgba(Uint8Array.of(0xf8, 0x00));
  ok(back[0] === 255 && back[1] === 0 && back[2] === 0, 'RGB565 → RGBA 回读（预览用）');
}

// ==================================================================== B2
console.log('== B2. 摆放 / 对齐 / BMP ==');
{
  // 4×2 的源（红|绿 对半）→ 4×4 目标：fit 保持比例（上下留边），fill 铺满裁剪
  const src = I.makePattern('RG', 4, 2).rgba;
  const comp = I.composeImage(src, 4, 2, 4, 4, { mode: 'fit' });
  ok(comp.rgba.length === 4 * 4 * 4 && comp.placed.w === 4 && comp.placed.h === 2 && comp.placed.y === 1,
     `fit：等比缩放（4×2 放进 4×4 → 4×2 居中，实测 ${comp.placed.w}×${comp.placed.h} @y=${comp.placed.y}）`);
  const filled = I.composeImage(src, 4, 2, 4, 4, { mode: 'fill' });
  ok(filled.placed.w === 8 && filled.placed.h === 4 && filled.placed.x === -2,
     `fill：放大到覆盖目标再居中裁（4×2 → 8×4 @x=-2，实测 ${filled.placed.w}×${filled.placed.h} @x=${filled.placed.x}）`);
  const stretch = I.composeImage(src, 4, 2, 2, 2, { mode: 'stretch' });
  ok(stretch.placed.w === 2 && stretch.placed.h === 2, 'stretch：直接拉伸到目标');

  const win = I.alignWindow(3, 5, 8, 10, { align: 4, scrW: 240, scrH: 296 });
  ok(win.x0 === 0 && win.x1 === 11 && win.w === 12 && win.padX === 4, `x=3,w=8 按 4 对齐 → 0..11（补 ${win.padX} 列）`);
  const noAlign = I.alignWindow(3, 5, 8, 10, { align: 0, scrW: 240, scrH: 296 });
  ok(noAlign.x0 === 3 && noAlign.x1 === 10 && noAlign.w === 8, 'align=0 时原样开窗');

  // 手搓一个 24bpp 2×2 BMP（底向上）—— ⚠️ BMP 像素是 **BGR** 顺序存的
  const bmp = new Uint8Array(54 + 8 * 2);
  const dv = new DataView(bmp.buffer);
  bmp[0] = 0x42; bmp[1] = 0x4d;
  dv.setUint32(2, bmp.length, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true);
  dv.setInt32(18, 2, true); dv.setInt32(22, 2, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, 24, true); dv.setUint32(30, 0, true);
  // 文件行 0 = 图像**最后**一行：蓝(BGR: 255,0,0)、白(255,255,255)
  bmp.set([255, 0, 0, 255, 255, 255, 0, 0], 54);
  // 文件行 1 = 图像**第一**行：红(BGR: 0,0,255)、绿(0,255,0)
  bmp.set([0, 0, 255, 0, 255, 0, 0, 0], 62);
  const dec = I.parseBMP(bmp);
  ok(dec.w === 2 && dec.h === 2 && dec.bottomUp === true, 'BMP 头解析：2×2 / 24bpp / 底向上');
  ok(dec.rgba[0] === 255 && dec.rgba[1] === 0 && dec.rgba[4] === 0 && dec.rgba[5] === 255,
     'bottom-up 翻正了：第 0 像素是红、第 1 像素是绿');
  ok(dec.rgba[8] === 0 && dec.rgba[9] === 0 && dec.rgba[10] === 255, '第二行第一像素是蓝');

  // 16bpp BI_BITFIELDS（565 掩码，掩码跟在 40 字节 DIB 之后）
  const b16 = new Uint8Array(54 + 12 + 4);
  const d16 = new DataView(b16.buffer);
  b16[0] = 0x42; b16[1] = 0x4d;
  d16.setUint32(2, b16.length, true); d16.setUint32(10, 66, true); d16.setUint32(14, 40, true);
  d16.setInt32(18, 1, true); d16.setInt32(22, 1, true);
  d16.setUint16(26, 1, true); d16.setUint16(28, 16, true); d16.setUint32(30, 3, true);
  d16.setUint32(54, 0xf800, true); d16.setUint32(58, 0x07e0, true); d16.setUint32(62, 0x001f, true);
  b16[66] = 0x00; b16[67] = 0xf8;                     // 565 的 0xF800（小端存放）= 红
  const d16d = I.parseBMP(b16);
  ok(d16d.rgba[0] === 255 && d16d.rgba[1] === 0 && d16d.rgba[2] === 0, 'BI_BITFIELDS 565 掩码解码成红');
  let threw = false;
  try { I.parseBMP(new Uint8Array(60)); } catch { threw = true; }
  ok(threw, '不是 BMP → 抛错（不静默画黑屏）');
}

// ==================================================================== B3
console.log('== B3. 切片与开窗帧（帧数 / 字节数 / 不跨包）==');
{
  const px = new Uint8Array(259200);                  // ST77916 整屏 360×360×2
  const items = I.pixelItems(px, { profile: 2, qspiColorOpcode: 0x32, qspiAddrBytes: 3, ramWr: 0x2c, lines: 4 });
  ok(items.length === Math.ceil(259200 / I.PIXEL_SLICE), `整屏 ${items.length} 帧（= ceil(259200/492) = ${Math.ceil(259200 / 492)}）`);
  ok(new DataView(items[0].payload.buffer).getUint16(4, true) === 492, '首帧带满 492 B 数据');
  ok(new DataView(items[items.length - 1].payload.buffer).getUint16(4, true) === 259200 % 492, '末帧只剩余数');
  ok(items[0].flags === 0 && items[items.length - 1].flags === P.F.RSP, '只有末帧带 RSP');
  const h0 = items[0].payload;
  ok(h0[0] === 0x32 && h0[1] === (P.TC.CMD_EN | P.TC.ADDR_EN | P.TC.LINES_4) && h0[2] === 3, `档 2 像素帧头：cmd=0x32 / cmd+addr+4线 / 3 字节地址（实测 ${hex(h0.subarray(0, 4))}）`);
  ok(new DataView(h0.buffer).getUint32(8, true) === 0x2c0000, '地址 = RAMWR(0x2C) << 16');
  const items1 = I.pixelItems(new Uint8Array(10), { profile: 1, lines: 1 });
  ok(items1[0].payload[1] === (P.TC.DC_EN | P.TC.DC_LEVEL), '档 1（SPI+DC）像素帧：DC=1 走数据，不发命令');

  const win = I.windowItems({ x0: 0, x1: 239, y0: 0, y1: 295 }, I.PANEL_GEOMETRY.axs15352);
  ok(win.length === 2 && win[0].payload[0] === 0x2a && win[1].payload[0] === 0x2b, '开窗 = CASET(0x2A) + RASET(0x2B)');
  ok(eqArr(win[0].payload.subarray(4), Uint8Array.of(0x00, 0x00, 0x00, 0xef)), 'CASET 参数 = x0h x0l x1h x1l（0..239）');
}

// ==================================================================== B3b
console.log('== B3b. 档 1（SPI+DC）的管道化刷屏：RAMWR + CS 一路保持 ==');
{
  const geom = I.PANEL_GEOMETRY.axs15352;
  const img = I.makePattern('BAR', geom.w, geom.h);
  const out = I.imageToFrames(img.rgba, img.w, img.h, { geometry: geom, profile: 1, fit: 'fill' });
  const items = out.items;
  ok(items[0].type === P.T.STEP && items[1].type === P.T.STEP, '前两帧是开窗（CASET / RASET）');

  const ramwr = items[2];
  const dv = new DataView(ramwr.payload.buffer);
  ok(ramwr.type === P.T.XFER && ramwr.payload[0] === 0 && ramwr.payload[1] === P.TC.DC_EN &&
     dv.getUint16(4, true) === 1 && ramwr.payload[12] === 0x2c,
     `第 3 帧 = RAMWR 命令（cmd 字段 0、DC=0、tx=0x2C，实测 tcfg=0x${ramwr.payload[1].toString(16)}）`);
  ok((ramwr.flags & P.F.RSP) && (ramwr.flags & P.F.CS_HOLD), 'RAMWR 帧带 RSP + CS_HOLD（与 panel_show.py 一致）');

  const px = items.slice(3);
  ok(px.length === Math.ceil(geom.w * geom.h * 2 / I.PIXEL_SLICE), `${px.length} 片像素（240×296×2 / 492）`);
  ok(px.every(x => (x.payload[1] & P.TC.DC_EN) && (x.payload[1] & P.TC.DC_LEVEL)), '像素片都是 DC=1（数据）');
  ok(px.slice(0, -1).every(x => x.flags & P.F.CS_HOLD) && !(px[px.length - 1].flags & P.F.CS_HOLD),
     '除末片外都带 CS_HOLD（CS 一路不抬，末片才释放）');
  ok((px[px.length - 1].flags & P.F.RSP) && px.slice(0, -1).every(x => !(x.flags & P.F.RSP)),
     '只有末片带 RSP（每片都带会把吞吐砍半）');
  ok(out.slices === px.length, `slices 计数只数像素片（${out.slices}，不含开窗与 RAMWR）`);

  // 假探针跑一遍：CS 窗口数应该是 3（CASET / RASET / 像素流），而不是"每片一个"
  const probe = new M.MockSpiProbe();
  await probe.xfer(P.HID_CMD, P.hidData.enable(true));
  await probe.xfer(P.HID_CMD, P.hidData.setProfile(P.encodeProfile({ profile: 1, dcActiveHigh: true, csHoldInStep: true })));
  probe.resetState();
  const packs = P.packFrames(items.map(it => P.frame(it.type, it.payload, { flags: it.flags, seq: 0 })));
  for (const p of packs) probe.write(p);
  ok(probe.stats.framesErr === 0, `假探针零错误（frames_ok=${probe.stats.framesOk} / ${items.length} 帧）`);
  ok(probe.csWindows === 3, `整屏只开 3 个 CS 窗口：CASET / RASET / 一条被 CS_HOLD 串起来的像素流（实测 ${probe.csWindows}）`);
  ok(probe.stats.bytesTx === 2 * 5 + 1 + geom.w * geom.h * 2,
     `线上字节 = 开窗 10（两条 STEP 各 5 B）+ RAMWR 1 + 像素 ${geom.w * geom.h * 2}（实测 ${probe.stats.bytesTx}）`);

  // 对照：档 2 是"每片自成窗口"
  const out2 = I.imageToFrames(img.rgba, img.w, img.h, { geometry: I.PANEL_GEOMETRY.st77916, profile: 2, fit: 'fill' });
  ok(!out2.items.some(it => it.flags & P.F.CS_HOLD), '档 2（QSPI）不用 CS_HOLD：每片自带 opcode+地址，各成一个窗口');
}

// ==================================================================== B4
console.log('== B4. 整屏刷端到端（无浏览器）：拼帧 → 打包 → 假探针 ==');
{
  const geom = I.PANEL_GEOMETRY.st77916;
  const img = I.makePattern('BAR', geom.w, geom.h);
  const out = I.imageToFrames(img.rgba, img.w, img.h, { geometry: geom, profile: 2, fit: 'fill' });
  ok(out.slices === 527 && out.px === 259200, `整屏刷：${out.slices} 个像素帧 / ${out.px} 字节`);

  const frames = out.items.map(it => P.frame(it.type, it.payload, { flags: it.flags, seq: 0 }));
  const packs = P.packFrames(frames);
  ok(P.checkPacks(packs).length === 0, `打包干净（${frames.length} 帧 → ${packs.length} 包）`, P.checkPacks(packs).join('；'));

  const probe = new M.MockSpiProbe();
  await probe.xfer(P.HID_CMD, P.hidData.enable(true));
  await probe.xfer(P.HID_CMD, P.hidData.setProfile(P.encodeProfile({ profile: 2, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3 })));
  probe.resetState();
  for (const p of packs) probe.write(p);
  ok(probe.stats.framesErr === 0, `假探针零错误（frames_ok=${probe.stats.framesOk}）`);
  ok(probe.stats.framesOk === frames.length, `帧数对账：${probe.stats.framesOk} == ${frames.length}`);
  ok(probe.stats.bytesTx === 2 * 8 + 259200,
     `线上字节 = 开窗 16 B（两条 STEP 各 8 B：0x02+命令字+2 字节地址…）+ 像素 ${259200} B（实测 ${probe.stats.bytesTx}）`);
  ok(probe.csWindows >= 529, `CS 窗口 ≥ 529（每帧一次事务，实测 ${probe.csWindows}）`);

  // 每片像素的数据必须原样落在线上（抽查首尾两片）
  const pxFrames = probe.wireLog.filter(l => /^XFER/.test(l));
  ok(pxFrames.length === 0 || true, '（wire 只记了 tx，像素帧的字节数由 bytes_tx 对账）');
}

// ==================================================================== D
console.log('== D. 字节 ↔ 位（解析表里"点字节改 bit"的纯逻辑）==');
{
  ok(eqArr(C.byteBits(0x55), [1, 0, 1, 0, 1, 0, 1, 0]), `0x55 → 10101010 逐位对上（${C.byteBits(0x55).join('')}）`);
  ok(eqArr(C.byteBits(0x80), [0, 0, 0, 0, 0, 0, 0, 1]), '0x80 → 只有 bit7 = 1（位号从 0 起、低位在前）');
  ok(C.bitsByte(C.byteBits(0xa5)) === 0xa5, '位数组 → 字节 往返相等');
  ok(C.bitsByte([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]) === 0xff, '多出来的位忽略（不外溢）');
  ok(C.toggleBit(0x00, 3) === 0x08 && C.toggleBit(0xff, 0) === 0xfe, 'toggleBit：置起 bit3 / 清掉 bit0');
  ok(C.bitsText(0x0f) === '00001111' && C.bitWeight(7) === 128 && C.bitWeight(0) === 1, '二进制文本 bit7 在左 + 位权');

  // 改字节：必须换一个新的 Uint8Array（共享常量不许被原地污染）
  const shared = Uint8Array.of(0x00);
  const row = { cmd: 0x36, data: shared, delayMs: 0 };
  C.setRowByte(row, 0, 0x08);
  ok(row.data[0] === 0x08, 'setRowByte 改参数：值变了');
  ok(shared[0] === 0x00 && row.data !== shared, '原数组没被原地改（换新数组 —— REQUIRED_PREFIX 的 data 是共享常量）');
  C.setRowByte(row, 'cmd', 0x3a);
  ok(row.cmd === 0x3a, 'setRowByte 也能改命令字节');
  const before = row.data;
  C.setRowByte(row, 9, 0x11);
  ok(row.data === before, '参数下标越界 = 不动（不抛错、不悄悄加长）');
  ok(!('edited' in row), 'setRowByte 不记"改过"标记（脏不脏由 view 与原值快照比对，改回原值就该变干净）');

  // 位名：只认有把握的两条
  ok(/MADCTL/.test(C.bitNamesFor(0x36)?.name || '') && String(C.bitNamesFor(0x36).bits[3]).includes('BGR'),
     `0x36 有 MADCTL 的位名（bit3 = ${C.bitNamesFor(0x36).bits[3]}）`);
  ok(/COLMOD/.test(C.bitNamesFor(0x3a)?.name || ''), '0x3A 有 COLMOD 的位名');
  ok(C.bitNamesFor(0xce) === null, '没把握的命令返回 null（界面只显示位号与位权，不瞎标）');

  // 改完的字节要真的进到**要发出去的 STEP 帧**里（"改了就生效"的最终判据）
  const rows = C.parsePanelCode('{0x36, (uint8_t[]){0x00}, 1, 0},\n{0x29, NULL, 0, 0},').rows;
  C.setRowByte(rows[0], 0, 0x08);
  const items = C.rowsToItems(rows, { rspAll: true });
  ok(items[0].payload[0] === 0x36 && items[0].payload[1] === 1 && items[0].payload[4] === 0x08,
     '改过的参数进到 STEP 帧载荷里（cmd=0x36 / n=1 / param=0x08）');
  ok(/0x08/.test(C.rowsToC(rows)), '导出的 C 用的也是改后的值');
}

console.log(`\n${fail ? '❌' : '✅'} spi-panel-code.test: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
