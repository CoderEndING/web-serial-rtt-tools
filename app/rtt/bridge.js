/**
 * 本地桥客户端（可选增强，零安装模式完全不需要它）。
 *
 * 为什么需要桥：J-Link 与 OpenOCD 都是**本机程序**，网页无权启动进程、也无权开 TCP。
 * 桥是一个 Node 单文件（bridge/rtt-bridge.mjs），双击启动后本页通过 WebSocket 连它。
 *
 * 桥暴露两种能力：
 *   · mem    —— 读写目标内存（OpenOCD 后端）：浏览器这边照跑完整 RTT 协议，能力最全
 *   · stream —— 纯字节流（J-Link 的 RTT telnet 19021，只有 ch0，全双工）
 */
import { toB64, fromB64 } from '../core/b64.js';

export class BridgeClient {
  constructor(url){
    // 允许用户只填 "ws://127.0.0.1:17321"：桥的 WebSocket 端点在 /ws，这里自动补上
    let u = String(url || 'ws://127.0.0.1:17321').trim();
    try {
      const p = new URL(u);
      if (!p.pathname || p.pathname === '/') p.pathname = '/ws';
      u = p.toString();
    } catch { /* 保持原样，让 connect() 报错更直观 */ }
    this.url = u;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.caps = [];
    this.info = null;
    this.onStream = null;
    this.onClose = null;
    this._closedByUs = false;
  }

  get connected(){ return this.ws && this.ws.readyState === WebSocket.OPEN; }

  async connect(hello = {}){
    if (this.connected) return;
    this._closedByUs = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`连不上桥（${this.url}）：请先双击 bridge/start-bridge.bat 启动它`)), 5000);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error(`连接桥失败（${this.url}）`)); };
    });
    ws.onmessage = ev => this._msg(ev.data);
    ws.onclose = () => {
      for (const [, p] of this.pending) p.rej(new Error('桥的连接已断开'));
      this.pending.clear();
      if (!this._closedByUs) this.onClose?.();
    };
    const ready = await this._call({ t: 'hello', ...hello });
    this.caps = ready.caps || [];
    return ready;
  }

  async open(backend, cfg = {}){
    const r = await this._call({ t: 'open', backend, cfg });
    this.info = r.info || null;
    return r;
  }

  _msg(data){
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'stream.data'){ this.onStream?.(fromB64(m.data || '')); return; }
    if (m.t === 'error' && m.id === undefined){ this.onClose?.(new Error(m.message)); return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.t === 'error') p.rej(new Error(m.message || '桥返回错误'));
    else p.res(m);
  }

  _call(msg, timeout = 15000){
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('桥未连接'));
    const id = ++this.seq;
    msg.id = id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      try { this.ws.send(JSON.stringify(msg)); }
      catch (e){ this.pending.delete(id); rej(e); return; }
      setTimeout(() => {
        if (this.pending.has(id)){ this.pending.delete(id); rej(new Error('桥响应超时')); }
      }, timeout);
    });
  }

  // ---------------- mem 能力（OpenOCD） ----------------
  async readMem(addr, len){
    if (len <= 0) return new Uint8Array(0);
    // OpenOCD 偶尔会短读（尤其在被高频轮询时）：短读重试一次再报错
    for (let attempt = 1; ; attempt++){
      const r = await this._call({ t: 'mem.read', addr, len }, 20000);
      const b = fromB64(r.data || '');
      if (b.length >= len) return b.subarray(0, len);
      if (attempt >= 2){
        if (!b.length) throw new Error(`读内存失败：0x${addr.toString(16)} 要 ${len} 字节，只回来 ${b.length} 字节（OpenOCD 忙不过来？把轮询间隔调大一点）`);
        const o = new Uint8Array(len); o.set(b); return o;
      }
      await new Promise(r2 => setTimeout(r2, 30));
    }
  }

  async writeMem(addr, bytes){
    await this._call({ t: 'mem.write', addr, data: toB64(bytes) }, 20000);
  }

  async reset(){ await this._call({ t: 'target.reset' }); }
  async halt(){ await this._call({ t: 'target.halt' }); }
  async go(){ await this._call({ t: 'target.go' }); }

  // ---------------- stream 能力（J-Link ch0） ----------------
  async streamWrite(bytes){ await this._call({ t: 'stream.write', data: toB64(bytes) }, 10000); }

  close(){
    this._closedByUs = true;
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}
