/**
 * HEX / 文本 / 字节 互转。
 * 解析规则（宽松，容错比严格重要）：
 *   "01 03 0A" / "0103 0A" / "0x01,0x03" / "01-03" / "01\n03" 都能解析成 [01,03,0A]
 *   奇数个十六进制数字、或出现非法字符 → 返回错误说明，由界面提示。
 */

const HEXCH = /^[0-9a-fA-F]+$/;

/** @returns {{bytes:Uint8Array, error:string|null}} */
export function parseHex(text){
  let s = String(text || '');
  // 去掉 0x / 0X 前缀与常见分隔符
  s = s.replace(/0[xX]/g, ' ').replace(/[,;:_\-\t\r\n|]/g, ' ');
  const toks = s.split(/\s+/).filter(Boolean);
  const out = [];
  let pending = '';
  for (const t of toks){
    if (!HEXCH.test(t)) return { bytes: new Uint8Array(0), error: `HEX 里有非法字符："${t}"` };
    let v = pending + t;
    pending = '';
    if (v.length % 2) { pending = v.slice(-1); v = v.slice(0, -1); }
    for (let i = 0; i < v.length; i += 2) out.push(parseInt(v.substr(i, 2), 16));
  }
  if (pending) return { bytes: new Uint8Array(0), error: `HEX 位数是奇数："${pending}"` };
  return { bytes: Uint8Array.from(out), error: null };
}

/** 字节 → 十六进制字符串 */
export function bytesToHex(b, sep = ' '){
  let s = '';
  for (let i = 0; i < b.length; i++){
    if (i) s += sep;
    s += b[i].toString(16).padStart(2, '0').toUpperCase();
  }
  return s;
}

/** 字节 → HEX 视图文本（每行 16 字节，遇到 0x0A 也换行） */
export function bytesToHexView(b){
  const rows = [];
  let row = [];
  for (let i = 0; i < b.length; i++){
    row.push(b[i].toString(16).padStart(2, '0').toUpperCase());
    if (row.length === 16 || b[i] === 0x0a){ rows.push(row.join(' ')); row = []; }
  }
  if (row.length) rows.push(row.join(' '));
  return rows.length ? rows.join('\n') + '\n' : '';
}

/** 可打印字符判定（ASCII 视图用它把不可打印字符显示成 ·） */
export function isPrintable(code){
  return code === 0x09 || (code >= 0x20 && code !== 0x7f);
}

// 控制字符（保留 \t \n \r）→ ·，其余原样 —— ANSI 转义序列属于"原样"，看得见才方便排错
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const ctrlMap = s => s.replace(CTRL, '·');

/**
 * 字节 → 文本。
 * 🚨 必须按 UTF-8 解码：早期版本是逐字节 String.fromCharCode（Latin-1），
 * 设备发中文时整句变成 `···`（自检用例抓到的）。不可打印字节仍显示成 ·。
 * @param {Uint8Array} b
 * @param {TextDecoder} [decoder] 传进来就按流式解码（跨包的多字节字符不会被拆坏）
 */
export function bytesToText(b, decoder){
  const s = decoder ? decoder.decode(b, { stream: true }) : new TextDecoder('utf-8', { fatal: false }).decode(b);
  return ctrlMap(s);
}

/** 追加行尾 */
export function withEol(text, eol){
  switch (eol){
    case 'crlf': return text + '\r\n';
    case 'cr': return text + '\r';
    case 'lf': return text + '\n';
    default: return text;
  }
}

/** 文本 → 字节（UTF-8） */
export function textToBytes(text){
  return new TextEncoder().encode(text);
}

export const EOL_LABEL = { none: '无', crlf: '\\r\\n', cr: '\\r', lf: '\\n' };
