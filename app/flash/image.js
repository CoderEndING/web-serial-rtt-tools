/**
 * 固件文件解析：ELF / Intel HEX / BIN → [ { addr, data:Uint8Array } ]（地址升序，相邻段合并）。
 * ELF/HEX 自带地址；BIN 没有地址信息，由调用方给基地址。
 */

/** 相邻（间隔 ≤ 4KB）的段合并成连续段，空隙补 0xFF（flash 擦除后的默认值） */
function mergeSegs(segs){
  segs.sort((a, b) => a.addr - b.addr);
  const out = [];
  for (const s of segs){
    const last = out[out.length - 1];
    if (last && s.addr <= last.addr + last.data.length + 4096){
      const end = last.addr + last.data.length;
      const gap = Math.max(0, s.addr - end);
      const merged = new Uint8Array(end - last.addr + gap + s.data.length);
      merged.set(last.data);
      merged.fill(0xff, end - last.addr, end - last.addr + gap);
      merged.set(s.data, end - last.addr + gap);
      last.data = merged;
    } else {
      out.push({ addr: s.addr, data: s.data });
    }
  }
  return out;
}

/** ELF32 小端：取 PT_LOAD 段（地址优先 p_paddr，那是烧到 flash 的 LMA） */
export function parseElfImage(u8){
  if (!(u8[0] === 0x7f && u8[1] === 0x45 && u8[2] === 0x4c && u8[3] === 0x46)) throw new Error('不是 ELF 文件（\\x7fELF 魔数不对）');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(4) !== 1) throw new Error('只支持 32 位 ELF（STM32 都是）');
  if (dv.getUint8(5) !== 1) throw new Error('只支持小端 ELF');
  const phoff = dv.getUint32(28, true);
  const phentsize = dv.getUint16(42, true);
  const phnum = dv.getUint16(44, true);
  const segs = [];
  for (let i = 0; i < phnum; i++){
    const o = phoff + i * phentsize;
    if (dv.getUint32(o, true) !== 1) continue;                 // PT_LOAD
    const off = dv.getUint32(o + 4, true);
    const vaddr = dv.getUint32(o + 8, true);
    const paddr = dv.getUint32(o + 12, true);
    const filesz = dv.getUint32(o + 16, true);
    if (!filesz) continue;                                     // .bss 之类没有文件内容
    segs.push({ addr: (paddr || vaddr) >>> 0, data: u8.slice(off, off + filesz) });
  }
  if (!segs.length) throw new Error('ELF 里没有带内容的可加载段');
  return mergeSegs(segs);
}

/** Intel HEX（:llaaaatt[dd...]cc） */
export function parseIntelHex(text){
  const HEX = /^([0-9a-fA-F]{2})+$/;
  const segs = [];
  let upper = 0;
  for (const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if (!line || !line.startsWith(':')) continue;
    const body = line.slice(1);
    if (!HEX.test(body)) throw new Error(`HEX 行格式不对：${line.slice(0, 20)}…`);
    const bin = new Uint8Array(body.length / 2);
    for (let i = 0; i < bin.length; i++) bin[i] = parseInt(body.substr(i * 2, 2), 16);
    const len = bin[0];
    const addr = ((bin[1] << 8) | bin[2]) >>> 0;
    const type = bin[3];
    const data = bin.slice(4, 4 + len);
    if (type === 0x00) segs.push({ addr: (upper + addr) >>> 0, data });
    else if (type === 0x01) break;                             // EOF
    else if (type === 0x04) upper = (((data[0] << 8) | data[1]) << 16) >>> 0;   // 扩展线性地址
    else if (type === 0x02) upper = (((data[0] << 8) | data[1]) << 4) >>> 0;    // 扩展段地址
    // 03/05（起始地址）忽略：烧录用段里的地址
  }
  if (!segs.length) throw new Error('HEX 里没有数据记录');
  return mergeSegs(segs);
}

/** 按扩展名解析；bin 用调用方给的基地址 */
export function parseFirmware(name, u8, base){
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.elf') || n.endsWith('.axf') || n.endsWith('.out')) return parseElfImage(u8);
  if (n.endsWith('.hex') || n.endsWith('.ihex')) return parseIntelHex(new TextDecoder().decode(u8));
  if (!base) throw new Error('.bin 没有地址信息：请填基地址（STM32 通用默认 0x08000000）');
  return [{ addr: base >>> 0, data: u8 }];
}
