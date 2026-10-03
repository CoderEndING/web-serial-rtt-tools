/**
 * 串口会话（Web Serial 封装）。串口助手与终端共用同一个会话：
 * 一个 COM 口只能被一个程序打开，共用才符合直觉（两个标签是同一路数据的两种看法）。
 *
 * 事件：open / close / data(Uint8Array, Date) / tx(Uint8Array) / error(Error)
 */
import { Bus } from '../core/bus.js';
import { waitMs } from '../core/pace.js';

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

  /**
   * @param {SerialPort} port
   * @param {{baudRate:number,dataBits:number,stopBits:number,parity:string,flowControl:string,
   *          dtr?:boolean,rts?:boolean,owner?:string}} opts
   *   `owner` = **这次打开是谁发起的**（'assistant' / 'rtt' …）。它会随 `open` 事件带出去：
   *   三个页面共用这一个会话，各自只该对"自己发起的那次"弹提示 / 起自动记录
   *   （2026-10 代码审查：以前不带，于是在串口助手里开普通 UART 也会弹 RTT 转发页那句
   *   「CDC 波特率不生效」，两页都勾自动记录还会把同一路数据写成两个文件）。
   */
  async open(port, opts){
    if (this.isOpen) await this.close();
    const o = {
      baudRate: Number(opts.baudRate) || 115200,
      dataBits: Number(opts.dataBits) || 8,
      stopBits: Number(opts.stopBits) || 1,
      parity: opts.parity || 'none',
      flowControl: opts.flowControl || 'none',
      /**
       * 🚨 4 KB 太小：高速流（RTT→CDC 打流，2 MB/s 级）下页面稍一忙 / 被切到后台，
       *    读取端慢一拍就会 `BufferOverrunError`（可恢复错误，但那个流会重来一次，
       *    看着像"丢数据"）。提到 64 KB 给读取端留出余量。
       *    （⚠️ 这一条来自 2026-10 代码审查的建议，**没有**在真机上复现过溢出；
       *      4 KB → 64 KB 只是加大缓冲，不改变任何语义。）
       */
      bufferSize: 65536,
      owner: opts.owner || '',
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
      /**
       * 🚨 外层 while **每轮都重新取 `port.readable`**，这是 Web Serial 的标准读法：
       *    帧错误（FramingError）/ 奇偶校验错（ParityError）/ `BufferOverrunError` 都是
       *    **非致命**的 —— 规范规定它们不会关端口，只是把 `readable` 换成一个**新流**，
       *    读循环接着读就行；只有真断开（拔线/被抢占）时 `readable` 才变成 null。
       *
       *    老代码内层**只有 finally、没有 catch**：线上一个坏字节（波特率选错、干扰、
       *    高速下缓冲溢出）就把整个循环掀到外层 catch，然后当成"串口已断开"发出去 ——
       *    可端口其实还开着（`isOpen` 仍是 true、`port.close()` 从没调过），状态前后不一致；
       *    而串口助手 / 终端 / RTT 转发共用这一个会话，于是**三个页面一起"断"**。
       *    （2026-10 代码审查）
       */
      while (this.isOpen && port.readable){
        this.reader = port.readable.getReader();
        try {
          while (true){
            const { value, done } = await this.reader.read();
            if (done) break;                       // 这个流结束：回外层看 readable 还在不在
            if (value && value.length) this.emit('data', value, new Date());
          }
        } catch (e){
          // 非致命错误：报一声继续（readable 已换成新流，外层的 while 会拿到它）
          if (this.isOpen && !this._closing) this.emit('error', e);
          await waitMs(20);                        // 让一步：万一 readable 没被换掉也不会把 CPU 空转满
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
    /**
     * 🚨 catch 里**不要 rethrow**：那会把 `_wq` 这条链永久留在 rejected 状态 ——
     *    之后每次 write() 的 then 体都被跳过（一个字节都写不出去），却对着同一个
     *    **旧**错误重复 emit('error')，直到重开串口。错误已经走过 'error' 事件了，
     *    这里把链恢复成 resolved，让后面的写继续。
     */
    this._wq = this._wq.then(async () => {
      if (!this.isOpen) throw new Error('串口已关闭');
      if (!this.writer) this.writer = this.port.writable.getWriter();
      await this.writer.write(data);
      this.emit('tx', data);
    }).catch(e => { this.emit('error', e); });
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
