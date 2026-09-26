/**
 * 串口会话（Web Serial 封装）。串口助手与终端共用同一个会话：
 * 一个 COM 口只能被一个程序打开，共用才符合直觉（两个标签是同一路数据的两种看法）。
 *
 * 事件：open / close / data(Uint8Array, Date) / tx(Uint8Array) / error(Error)
 */
import { Bus } from '../core/bus.js';

export class SerialSession extends Bus {
  constructor(){
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.isOpen = false;
    this.opts = null;
    this.info = null;
    this._wq = Promise.resolve();
    this._closing = false;
  }

  static supported(){ return typeof navigator !== 'undefined' && 'serial' in navigator; }

  static async listPorts(){
    if (!SerialSession.supported()) return [];
    try { return await navigator.serial.getPorts(); } catch { return []; }
  }

  static async requestPort(){
    if (!SerialSession.supported()) throw new Error('这个浏览器不支持 Web Serial（请用桌面版 Chrome / Edge）');
    return await navigator.serial.requestPort();
  }

  static describe(port){
    let i = {};
    try { i = port.getInfo ? port.getInfo() : {}; } catch {}
    const vid = i.usbVendorId != null ? i.usbVendorId.toString(16).toUpperCase().padStart(4, '0') : null;
    const pid = i.usbProductId != null ? i.usbProductId.toString(16).toUpperCase().padStart(4, '0') : null;
    return vid && pid ? `${vid}:${pid}` : '（无 USB 信息）';
  }

  /** @param {SerialPort} port @param {{baudRate:number,dataBits:number,stopBits:number,parity:string,flowControl:string,dtr?:boolean,rts?:boolean}} opts */
  async open(port, opts){
    if (this.isOpen) await this.close();
    const o = {
      baudRate: Number(opts.baudRate) || 115200,
      dataBits: Number(opts.dataBits) || 8,
      stopBits: Number(opts.stopBits) || 1,
      parity: opts.parity || 'none',
      flowControl: opts.flowControl || 'none',
      bufferSize: 4096,
    };
    await port.open(o);
    this.port = port;
    this.opts = o;
    this.info = SerialSession.describe(port);
    this.isOpen = true;
    this._closing = false;
    // DTR/RTS：默认都不拉（很多开发板靠 DTR/RTS 复位/进下载模式，别乱动）
    try { await port.setSignals({ dataTerminalReady: !!opts.dtr, requestToSend: !!opts.rts }); } catch {}
    this.emit('open', { opts: o, info: this.info });
    this._readLoop();
  }

  async _readLoop(){
    const port = this.port;
    try {
      while (this.isOpen && port.readable){
        this.reader = port.readable.getReader();
        try {
          while (true){
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && value.length) this.emit('data', value, new Date());
          }
        } finally {
          try { this.reader.releaseLock(); } catch {}
          this.reader = null;
        }
      }
    } catch (e){
      if (!this._closing && this.isOpen) this.emit('error', e);
    }
    if (this.isOpen) this.emit('close', { unexpected: !this._closing });
  }

  async close(){
    if (!this.isOpen) return;
    this._closing = true;
    this.isOpen = false;
    try { if (this.reader) await this.reader.cancel(); } catch {}
    try { if (this.writer){ this.writer.releaseLock(); this.writer = null; } } catch {}
    try { await this.port.close(); } catch (e){ console.warn('关闭串口出错', e); }
    const p = this.port;
    this.port = null; this.opts = null; this.info = null;
    this.emit('close', { unexpected: false, port: p });
  }

  /** 写入（串行排队：Web Serial 同一时刻只允许一个 write） */
  write(bytes){
    if (!this.isOpen || !this.port) return Promise.reject(new Error('串口未打开'));
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this._wq = this._wq.then(async () => {
      if (!this.isOpen) throw new Error('串口已关闭');
      if (!this.writer) this.writer = this.port.writable.getWriter();
      await this.writer.write(data);
      this.emit('tx', data);
    }).catch(e => { this.emit('error', e); throw e; });
    return this._wq.catch(() => {});
  }

  async setSignals({ dtr, rts }){
    if (!this.isOpen) return;
    const s = {};
    if (dtr !== undefined) s.dataTerminalReady = !!dtr;
    if (rts !== undefined) s.requestToSend = !!rts;
    if (Object.keys(s).length) await this.port.setSignals(s);
  }
}
