/**
 * 采集落文件：收到的字节**边收边写进本地文件**，不占页面内存。
 *
 * 为什么需要它：接收区是"显示优先"的 —— raw 上限 2 MB（`RxBuffer.maxRaw`），
 * 高速采集几秒就撑爆（WebUSB 实测 330 KB/s → 2 MB 只够 6 秒），超出的只能丢；
 * 「保存数据」也只能保存没被丢的那部分。落文件的字节**不进显示缓冲**，
 * 采集多久都不丢，页面卡不卡、有没有被限速都不影响已经写下去的字节。
 *
 * 两条路：
 *   ① File System Access API（`showSaveFilePicker` + `createWritable`）——
 *      Chrome/Edge 桌面版都有；选好文件后一直往里追加，**停止时落盘**。
 *   ② 没有这个 API（Firefox/Safari，它们本来也没有 Web Serial/WebUSB）→
 *      先在内存里攒（有上限），停止时下载；攒满上限会置 overflow 标记，如实告诉用户。
 *
 * 两种写法：
 *   原样（.bin）：字节流原封不动，二进制安全，方便事后解析；
 *   带时间戳（.log）：每段前面加一行 `[HH:MM:SS.mmm] `，给人看。
 *
 * ⚠️ 写入是**批量异步**的（默认攒 256 KB 或 300 ms 写一次），push 本身不做 I/O，
 *    不会拖慢接收回路；停止时等最后一批写完再 close。
 */
import { stamp as stampOf, fileStamp, download } from './format.js';

const FLUSH_BYTES = 256 * 1024;
const FLUSH_MS = 300;
const MEM_CAP = 64 * 1024 * 1024;

const enc = new TextEncoder();

export class FileRecorder {
  static supported(){
    return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
  }

  constructor(){
    this.active = false;
    this.name = '';                 // 文件名（没有 API 时是建议名）
    this.timestamps = false;
    this.bytes = 0;                 // 已记账的原始字节数（不含时间戳前缀）
    this.frames = 0;
    this.t0 = 0;
    this.overflow = false;          // 内存兜底模式攒爆了
    this.error = null;
    this.onChange = null;           // 供界面刷新按钮文字
    this._w = null;                 // FileSystemWritableFileStream
    this._wq = Promise.resolve();   // 写队列（保证顺序、终止时可等）
    this._chunks = [];
    this._pend = 0;
    this._mem = [];
    this._memBytes = 0;
    this._timer = null;
  }

  /**
   * 开始记录。**必须在用户手势里调用**（showSaveFilePicker 的硬要求）。
   * @param {{name?:string, timestamps?:boolean}} opts
   * @returns {Promise<string>} 文件名
   */
  async start({ name = 'capture', timestamps = false } = {}){
    if (this.active) return this.name;
    this.timestamps = timestamps;
    if (FileRecorder.supported()){
      const ext = timestamps ? 'log' : 'bin';
      const handle = await window.showSaveFilePicker({
        suggestedName: `${name}-${fileStamp()}.${ext}`,
        types: [{ description: timestamps ? '带时间戳的文本日志' : '原始字节流', accept: { 'application/octet-stream': ['.bin', '.log', '.txt'] } }],
      });
      this.name = handle.name || `${name}.${ext}`;
      this._w = await handle.createWritable();
    } else {
      this.name = `${name}-${fileStamp()}.${timestamps ? 'log' : 'bin'}`;
    }
    this.bytes = 0; this.frames = 0; this.overflow = false; this.error = null;
    this.t0 = Date.now();
    this.active = true;
    this._timer = setInterval(() => this._flush(), FLUSH_MS);
    this.onChange?.();
    return this.name;
  }

  /** 收流：只入队，不做 I/O（高速通路上不要在这里写盘） */
  push(bytes, t = new Date()){
    if (!this.active || !bytes?.length) return;
    if (this.timestamps){
      const head = enc.encode(`[${stampOf(t)}] `);
      this._chunks.push(head, bytes);
      this._pend += head.length + bytes.length;
    } else {
      this._chunks.push(bytes);
      this._pend += bytes.length;
    }
    this.bytes += bytes.length;
    this.frames++;
    if (this._pend >= FLUSH_BYTES) this._flush();
  }

  _flush(){
    if (!this._chunks.length) return;
    const chunks = this._chunks;
    this._chunks = [];
    this._pend = 0;
    if (this._w){
      const w = this._w;
      this._wq = this._wq.then(async () => { for (const c of chunks) await w.write(c); }).catch(e => this._fail(e));
    } else {
      for (const c of chunks){
        if (this._memBytes + c.length > MEM_CAP){ this.overflow = true; return; }
        this._mem.push(c); this._memBytes += c.length;
      }
    }
  }

  _fail(e){
    this.error = e;
    this.active = false;
    clearInterval(this._timer); this._timer = null;
    this.onChange?.();
  }

  /** 停止并落盘；@returns {{name,bytes,frames,seconds,overflow,error}} */
  async stop(){
    if (!this.active && !this._w) return null;
    const info = { name: this.name, bytes: this.bytes, frames: this.frames, seconds: (Date.now() - this.t0) / 1000, overflow: this.overflow, error: this.error };
    this.active = false;
    clearInterval(this._timer); this._timer = null;
    this._flush();
    await this._wq;
    if (this._w){
      try { await this._w.close(); } catch (e){ info.error = info.error || e; }
      this._w = null;
    } else if (this._mem.length){
      download(this.name, new Blob(this._mem, { type: 'application/octet-stream' }));
    }
    this._mem = []; this._memBytes = 0;
    this.onChange?.();
    return info;
  }
}
