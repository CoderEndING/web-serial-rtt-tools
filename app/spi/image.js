/**
 * 图片 → 屏幕上的一串帧（纯函数，Node 自测直接打）。
 *
 * 分工：
 *   · **这里**干"与像素有关的一切**：内置图案生成、BMP 解码、缩放/摆放、RGB565 转换、切片、拼帧。
 *     canvas 只负责两件浏览器专有的事：解码 PNG/JPEG、把预览画出来 —— 那部分在视图里。
 *     这样"发出去的字节对不对"完全可以在 Node 里逐字节对账，不用开浏览器。
 *   · 探针做**字节透明**转发，所以字节序（RGB565 高字节在前）与 R/B 交换都由这里负责。
 *
 * 切片上限：一帧 payload ≤ 504 B，XFER 还要 12 B 头 → **像素片最大 492 B**；
 * 而且**一帧不跨 512 B 包**（见 protocol.packFrames）。
 */
import { F, T, TC, stepPayload, xferPayload } from './protocol.js';

/** 单帧能带的像素数据（XFER 头 12 B + 数据 ≤ 504）*/
export const PIXEL_SLICE = 492;

/** 两块目标屏的几何与开窗命令（换屏只改这里 / 页面上可覆写）*/
export const PANEL_GEOMETRY = {
  axs15352: { w: 240, h: 296, colCmd: 0x2a, rowCmd: 0x2b, ramWr: 0x2c, lines: 1, colorOpcode: null, align: 4 },
  st77916: { w: 360, h: 360, colCmd: 0x2a, rowCmd: 0x2b, ramWr: 0x2c, lines: 4, colorOpcode: 0x32, align: 4 },
};

// ============================================================================
// 内置图案（照 bmp_sender 那套：纯色 / 混色 / 对半 / 棋盘 / 色条 / 渐变 / 网格）
// ============================================================================

export const PATTERNS = [
  ['红 R', 'R'], ['绿 G', 'G'], ['蓝 B', 'B'],
  ['黄 R+G', 'MRG'], ['品红 R+B', 'MRB'], ['青 G+B', 'MGB'],
  ['白 W', 'W'], ['黑 K', 'K'], ['灰 GY', 'GY'],
  ['混色卡', 'MIX'], ['色条 8', 'BAR'],
  ['对半 红|绿', 'RG'], ['对半 绿|蓝', 'GB'], ['对半 红|蓝', 'RB'],
  ['棋盘 16px', 'CH'], ['棋盘 1px', 'CH1'],
  ['渐变', 'RAMP'], ['4px 网格', 'GRID'],
];

/** @returns {{w:number,h:number,rgba:Uint8Array}} */
export function makePattern(kind, w, h){
  const rgba = new Uint8Array(w * h * 4);
  const set = (i, r, g, b) => { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; };
  const solid = (r, g, b) => { for (let i = 0; i < w * h * 4; i += 4) set(i, r, g, b); };
  const half = (c1, c2) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set((y * w + x) * 4, ...(x < w / 2 ? c1 : c2));
  };
  const BARS = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  switch (kind){
    case 'R': solid(255, 0, 0); break;
    case 'G': solid(0, 255, 0); break;
    case 'B': solid(0, 0, 255); break;
    case 'MRG': solid(255, 255, 0); break;
    case 'MRB': solid(255, 0, 255); break;
    case 'MGB': solid(0, 255, 255); break;
    case 'W': solid(255, 255, 255); break;
    case 'K': solid(0, 0, 0); break;
    case 'GY': solid(128, 128, 128); break;
    case 'RG': half([255, 0, 0], [0, 255, 0]); break;
    case 'GB': half([0, 255, 0], [0, 0, 255]); break;
    case 'RB': half([255, 0, 0], [0, 0, 255]); break;
    case 'MIX': {
      const cw = Math.floor(w / 3), ch = Math.floor(h / 4);
      const rows = [[[255, 0, 0], [0, 255, 0], [0, 0, 255]],
                    [[255, 255, 0], [255, 0, 255], [0, 255, 255]],
                    [[255, 255, 255], [128, 128, 128], [0, 0, 0]]];
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++)
          for (let y = r * ch; y < Math.min((r + 1) * ch, h); y++)
            for (let x = c * cw; x < Math.min((c + 1) * cw, w); x++) set((y * w + x) * 4, ...rows[r][c]);
      for (let i = 0; i < 8; i++)
        for (let y = 3 * ch; y < h; y++)
          for (let x = Math.floor(i * w / 8); x < Math.floor((i + 1) * w / 8); x++) set((y * w + x) * 4, ...BARS[i]);
      break;
    }
    case 'BAR':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set((y * w + x) * 4, ...BARS[Math.min(7, Math.floor(x / (w / 8)))]);
      break;
    case 'CH':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
        const on = (((x >> 4) + (y >> 4)) & 1) ? 255 : 0;
        set((y * w + x) * 4, on, on, on);
      } break;
    case 'CH1':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
        const on = ((x + y) & 1) ? 255 : 0;
        set((y * w + x) * 4, on, on, on);
      } break;
    case 'RAMP':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
        set((y * w + x) * 4, Math.round(x * 255 / Math.max(1, w - 1)),
            Math.round(y * 255 / Math.max(1, h - 1)),
            Math.round((x + y) * 255 / Math.max(1, w + h - 2)));
      } break;
    case 'GRID':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
        const on = (x % 4 === 0) || (y % 8 === 0);
        const v = on ? 255 : 16;
        set((y * w + x) * 4, v, v, v);
      } break;
    default: solid(0, 0, 0);
  }
  return { w, h, rgba };
}

// ============================================================================
// 摆放：把源图放进屏（等比适应 / 铺满裁剪 / 拉伸 / 原始居中）
// ============================================================================

/**
 * 把源 RGBA 合到 dw×dh 的画布上（最近邻采样 —— 屏很小，够用；而且纯 JS 才能逐字节对账）。
 * @returns {{rgba:Uint8Array, w:number, h:number, placed:{x:number,y:number,w:number,h:number}}}
 */
export function composeImage(src, sw, sh, dw, dh, opts = {}){
  const mode = opts.mode || 'fit';
  const bg = opts.bg || [0, 0, 0];
  const out = new Uint8Array(dw * dh * 4);
  for (let i = 0; i < dw * dh; i++){ out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255; }

  let tw, th;
  if (mode === 'stretch'){ tw = dw; th = dh; }
  else if (mode === 'none'){ tw = sw; th = sh; }
  else {
    const k = mode === 'fill' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
    tw = Math.max(1, Math.round(sw * k)); th = Math.max(1, Math.round(sh * k));
  }
  const ox = Math.round((dw - tw) / 2), oy = Math.round((dh - th) / 2);

  for (let y = 0; y < th; y++){
    const dy = oy + y;
    if (dy < 0 || dy >= dh) continue;
    const sy = Math.min(sh - 1, Math.floor(y * sh / th));
    for (let x = 0; x < tw; x++){
      const dx = ox + x;
      if (dx < 0 || dx >= dw) continue;
      const sx = Math.min(sw - 1, Math.floor(x * sw / tw));
      const si = (sy * sw + sx) * 4, di = (dy * dw + dx) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return { rgba: out, w: dw, h: dh, placed: { x: ox, y: oy, w: tw, h: th } };
}

// ============================================================================
// RGB565（高字节在前；R/B 可交换）
// ============================================================================

/**
 * RGBA → RGB565 字节流（默认**高字节在前** —— AXS15352 与 ST77916 都是这个组合）。
 *
 * ⚠️ 色序有**两处会互相抵消**的开关，别两个一起翻（交接文档 §5 的实测结论）：
 *   · `R/B 交换`（swap）—— 等价于改 MADCTL(0x36) 的 bit3（BGR 位）；
 *   · `低字节在前`（littleEndian）—— 纯粹的字节序。
 * 正确组合是「MADCTL=0x00 + 高字节在前」；颜色不对时**只动一个**再试。
 *
 * @param {{swap?:boolean, littleEndian?:boolean, level?:number}} opts
 *        swap = R/B 交换；littleEndian = 低字节在前；level = 灰阶（把满量程分量压到该值，255 = 不改）
 */
export function rgbaTo565(rgba, opts = {}){
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 2);
  const swap = !!opts.swap;
  const le = !!opts.littleEndian;
  const level = opts.level == null || opts.level >= 255 ? null : Math.max(0, Math.min(255, opts.level | 0));
  for (let i = 0; i < n; i++){
    let r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (level != null){
      if (r === 255) r = level;
      if (g === 255) g = level;
      if (b === 255) b = level;
    }
    if (swap){ const t = r; r = b; b = t; }
    const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    out[i * 2] = le ? (v & 0xff) : ((v >> 8) & 0xff);
    out[i * 2 + 1] = le ? ((v >> 8) & 0xff) : (v & 0xff);
  }
  return out;
}

/** RGB565 字节流 → 预览用的 RGBA（页面上"将要发出去的样子"）*/
export function rgb565ToRgba(bytes){
  const n = bytes.length / 2;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++){
    const v = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
    out[i * 4] = ((v >> 11) & 31) * 255 / 31 | 0;
    out[i * 4 + 1] = ((v >> 5) & 63) * 255 / 63 | 0;
    out[i * 4 + 2] = (v & 31) * 255 / 31 | 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ============================================================================
// BMP（16/24bpp；BI_RGB / BI_BITFIELDS）—— 浏览器不解 BMP 的 16bpp，所以自己来
// ============================================================================

export function parseBMP(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) throw new Error('不是 BMP 文件（要 BM 开头）');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const offBits = dv.getUint32(10, true);
  const dibSize = dv.getUint32(14, true);
  if (dibSize < 40) throw new Error('DIB 头太小：' + dibSize);
  const w = dv.getInt32(18, true);
  const hs = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const comp = dv.getUint32(30, true);
  if (w <= 0 || hs === 0) throw new Error('宽高非法');
  if (bpp !== 16 && bpp !== 24) throw new Error(`只支持 16/24bpp，这张是 ${bpp}bpp`);
  if (comp !== 0 && comp !== 3) throw new Error('压缩方式 ' + comp + ' 不支持（RLE 请先转成 BI_RGB）');
  const h = Math.abs(hs);
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  const rgba = new Uint8Array(w * h * 4);
  let rm = 0, gm = 0, bm = 0;
  if (comp === 3 && bpp === 16){
    const mo = dibSize >= 52 ? 54 : 14 + dibSize;
    rm = dv.getUint32(mo, true); gm = dv.getUint32(mo + 4, true); bm = dv.getUint32(mo + 8, true);
  }
  const field = (v, mask) => {
    if (!mask) return 0;
    let sh = 0; while (sh < 32 && !((mask >>> sh) & 1)) sh++;
    let mm = mask >>> sh, bits = 0; while (bits < 32 && ((mm >>> bits) & 1)) bits++;
    const raw = (v >>> sh) & mm;
    return Math.round(raw * 255 / ((1 << bits) - 1));
  };
  for (let y = 0; y < h; y++){
    const fileRow = hs > 0 ? (h - 1 - y) : y;          // BMP 默认 bottom-up
    const base = offBits + fileRow * stride;
    for (let x = 0; x < w; x++){
      let r, g, bl;
      if (bpp === 24){ bl = b[base + x * 3]; g = b[base + x * 3 + 1]; r = b[base + x * 3 + 2]; }
      else {
        const v = (b[base + x * 2] | (b[base + x * 2 + 1] << 8)) & 0xffff;
        if (rm | gm | bm){ r = field(v, rm); g = field(v, gm); bl = field(v, bm); }
        else { r = Math.round(((v >> 10) & 31) * 255 / 31); g = Math.round(((v >> 5) & 31) * 255 / 31); bl = Math.round((v & 31) * 255 / 31); }
      }
      const i = (y * w + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = bl; rgba[i + 3] = 255;
    }
  }
  return { w, h, bpp, comp, bottomUp: hs > 0, rgba };
}

// ============================================================================
// 开窗 + 像素切片的帧序列
// ============================================================================

/**
 * 开窗：CASET / RASET。
 *
 * 档 0/1 用 `STEP` 帧（固件按档展开：档 1 = 同一个 CS 窗口内"DC 命令 → 翻 DC → 参数"）。
 *
 * 档 2（QSPI）**直接发 XFER，不走 STEP** —— 因为固件当前的 `sb_step_qspi()` 把命令字放在
 * 24 bit 地址的**最低字节**（`addr = cmd`，线上 `02 | 00 00 XX`），而 ST77916 数据手册 §8.8.5.1
 * 写得很明确：`02h` 之后 3 字节 AD[23:0] = **`00 XX 00`**（"1 byte of 0x00, 1 byte of command
 * address and 1 byte of 0x00"，`CMD : 0x00XX00`）。ESP-IDF 官方驱动也是这么做的
 * （`esp_lcd_st77916_spi.c`：`lcd_cmd <<= 8`）。走 STEP 的 QSPI 命令一条都认不出来，
 * 所以这里绕开它：地址 = `命令字 << 8`。
 */
export function windowItems({ x0, x1, y0, y1 }, g = {}, o = {}){
  const col = g.colCmd ?? 0x2a, row = g.rowCmd ?? 0x2b;
  const coord = v => Uint8Array.of((v >> 8) & 0xff, v & 0xff);
  const body = () => Uint8Array.from([...coord(x0), ...coord(x1)]);
  const bodyRow = () => Uint8Array.from([...coord(y0), ...coord(y1)]);
  if (o.profile === 2){
    // QSPI：opcode(默认 0x02) + AD[23:0] = 0x00<命令字>00 + 1 线参数
    const opcode = (o.qspiWrOpcode ?? 0x02) & 0xff;
    const addrLen = o.qspiAddrBytes ?? 3;
    const mk = (cmdByte, params, label) => ({
      type: T.XFER,
      payload: xferPayload({ cmd: opcode, tcfg: TC.LINES_1 | TC.CMD_EN | TC.ADDR_EN, addrLen,
                             addr: ((cmdByte & 0xff) << 8) >>> 0, dummy: 0, tx: params, rxLen: 0 }),
      flags: 0, label,
    });
    return [ mk(col, body(), `CASET ${x0}..${x1}（QSPI 0x${opcode.toString(16)} + 00 ${col.toString(16)} 00）`),
             mk(row, bodyRow(), `RASET ${y0}..${y1}（QSPI 0x${opcode.toString(16)} + 00 ${row.toString(16)} 00）`) ];
  }
  return [
    { type: T.STEP, payload: stepPayload({ cmd: col, params: body(), delayMs: 0 }), flags: 0, label: `CASET ${x0}..${x1}` },
    { type: T.STEP, payload: stepPayload({ cmd: row, params: bodyRow(), delayMs: 0 }), flags: 0, label: `RASET ${y0}..${y1}` },
  ];
}

/**
 * 档 1（SPI + DC）刷像素的**第一帧**：RAMWR 命令本身（DC=0），并且**保持 CS** —— 后面所有像素片
 * 都在同一个 CS 窗口里发完（真机验证过的"管道化"做法，见 akaLinkPro `tools/panel_show.py:133-143`）。
 *
 * 档 2（QSPI）不需要它：每片像素自带 `0x32 + 24bit 地址`。
 */
export function ramwrCommandItem(o = {}){
  const cmdByte = (o.ramWr ?? 0x2c) & 0xff;
  const lines = o.lines === 4 ? TC.LINES_4 : o.lines === 2 ? TC.LINES_2 : TC.LINES_1;
  return {
    type: T.XFER,
    payload: xferPayload({ cmd: 0, tcfg: lines | TC.DC_EN, addrLen: 0, addr: 0, tx: Uint8Array.of(cmdByte), rxLen: 0 }),
    flags: F.RSP | F.CS_HOLD,
    label: `RAMWR 0x${cmdByte.toString(16)}（DC=0，CS 保持）`,
  };
}

/**
 * 像素数据 → XFER 帧（每片 ≤ 492 B）。
 *
 * 两种档位的线上结构**不一样**（都是真机验证过的）：
 *   · 档 2（QSPI）：每片自带 `cmd=qspi_color_opcode` + 24 bit 地址（= RAMWR<<16）+ 四线数据，各自一个 CS 窗口；
 *   · 档 1（SPI+DC）：**先发一帧 RAMWR 命令**（见 `ramwrCommandItem`，DC=0），
 *     然后所有像素片 DC=1 且**除最后一片外都带 `CS_HOLD`** —— CS 一路不抬，最后一片才释放。
 */
export function pixelItems(px, o = {}){
  const slice = o.sliceBytes ?? PIXEL_SLICE;
  const profile = o.profile | 0;
  const lines = o.lines || 1;
  const items = [];
  let first = true;
  for (let off = 0; off < px.length; off += slice){
    const end = Math.min(off + slice, px.length);
    const tx = px.subarray(off, end);
    const last = end >= px.length;
    let tcfg = lines === 4 ? TC.LINES_4 : lines === 2 ? TC.LINES_2 : TC.LINES_1;
    let cmd = 0, addrLen = 0, addr = 0, flags = 0;
    if (profile === 2){
      /**
       * 🚨 QSPI 的像素是**一条命令 + 整帧连续流**（CS 全程保持），不是"每片各自一条命令"：
       *   · 数据手册 §8.8.5.1：`32h` 之后是 AD[23:0] = `00 2C 00`，然后连续写；
       *   · ESP-IDF 官方驱动就是这么干的（一次 `tx_color` 把整帧 DMA 出去，CS 不抬）。
       *   每片都重发 `32h + 00 2C 00` 会把面板的写地址计数器**打回窗口原点**（一片盖一片）。
       *   所以：只有**首片**带 cmd+addr，后面的片都是纯数据相位（4 线），CS 一路保持到末片。
       *   地址同样是 `命令字 << 8`（线上 `00 2C 00`），不是 `<< 16`。
       */
      if (first){ tcfg |= TC.CMD_EN | TC.ADDR_EN; }
      cmd = o.qspiColorOpcode ?? 0x32;
      addrLen = first ? (o.qspiAddrBytes ?? 3) : 0;
      addr = first ? (((o.ramWr ?? 0x2c) << 8) >>> 0) : 0;
      if (!last) flags |= F.CS_HOLD;           // 一整帧在同一个 CS 窗口里（与档 1 同一个做法）
      first = false;
    } else if (profile === 1){
      tcfg |= TC.DC_EN | TC.DC_LEVEL;          // DC=1 → 数据
      if (!last) flags |= F.CS_HOLD;           // CS 保持到最后一刻
    }
    if (last) flags |= F.RSP;                   // 只有最后一片要应答（每片都带会把吞吐砍半）
    items.push({
      type: T.XFER,
      payload: xferPayload({ cmd, tcfg, addrLen, addr, dummy: 0, tx, rxLen: 0 }),
      flags,
      label: `像素 ${off}..${end - 1}${last ? '（末片）' : ''}`,
    });
  }
  return items;
}

/**
 * 开窗对齐：屏（至少 AXS15352）要求列地址按 4 像素对齐 —— 这里把"要刷的区域"扩到对齐边界。
 * @returns {{x0,x1,y0,y1,w,h,padX:number}}
 */
export function alignWindow(x, y, w, h, o = {}){
  const align = o.align ?? 0;
  const scrW = o.scrW ?? 1 << 16, scrH = o.scrH ?? 1 << 16;
  let x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
  let x1 = Math.min(scrW - 1, x0 + (w | 0) - 1), y1 = Math.min(scrH - 1, y0 + (h | 0) - 1);
  const rawW = x1 - x0 + 1;
  if (align > 1){
    x0 = x0 & ~(align - 1);
    x1 = Math.min(scrW - 1, ((x1 + align) & ~(align - 1)) - 1);
  }
  return { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, padX: (x1 - x0 + 1) - rawW };
}

/**
 * 把一张 RGBA 源图变成"开窗 + 像素"的完整帧序列（页面上一次刷屏就调它）。
 *
 * 顺序（档 1 与档 2 的差别只在中间那一帧）：
 *   CASET / RASET（STEP 帧）
 *   → 〔档 1 才有的 RAMWR 命令帧，DC=0 + CS_HOLD〕
 *   → 像素片 ×N（档 1 除末片都带 CS_HOLD；档 2 每片自成窗口）
 * @returns {{items:Array, placed:object, px:number, slices:number}}
 */
export function imageToFrames(src, sw, sh, o = {}){
  const g = o.geometry || PANEL_GEOMETRY.st77916;
  const x = o.x ?? 0, y = o.y ?? 0;
  const profile = o.profile ?? 0;
  const lines = o.lines ?? g.lines;
  const win = alignWindow(x, y, o.w ?? sw, o.h ?? sh, { align: g.align, scrW: g.w, scrH: g.h });
  const composed = composeImage(src, sw, sh, win.w, win.h, { mode: o.fit || 'fill' });
  const px = rgbaTo565(composed.rgba, { swap: o.swap, littleEndian: o.littleEndian, level: o.level });
  const items = [
    ...windowItems(win, g, { profile, qspiWrOpcode: o.qspiWrOpcode, qspiAddrBytes: o.qspiAddrBytes ?? 3 }),
    ...(profile === 1 ? [ramwrCommandItem({ ramWr: g.ramWr, lines })] : []),
    ...pixelItems(px, {
      profile, qspiColorOpcode: g.colorOpcode ?? o.qspiColorOpcode,
      qspiAddrBytes: o.qspiAddrBytes ?? 3, ramWr: g.ramWr, lines,
      sliceBytes: o.sliceBytes ?? PIXEL_SLICE,
    }),
  ];
  return { items, placed: composed.placed, window: win, px: px.length, slices: items.length - 2 - (profile === 1 ? 1 : 0), bytes: px };
}
