#!/usr/bin/env node
/**
 * rtt-bridge —— 给「串口 / RTT 工具箱」网页当本地桥（**可选**，零安装模式不需要它）。
 *
 * 为什么存在：J-Link 与 OpenOCD 都是本机程序，浏览器无权启动进程、也无权开 TCP。
 * 桥做三件事：
 *   ① 把仓库里的网页也托管一份到 http://127.0.0.1:17321/（同源 → 没有混合内容/
 *      本地网络访问权限提示；Web Serial 在 localhost 也算安全上下文）；
 *   ② WebSocket 服务（手写握手+帧，零 npm 依赖），把网页的请求翻译成调试器操作；
 *   ③ 两种后端：
 *      · openocd —— 走 OpenOCD 的 Tcl RPC(6666) 读写目标内存 + 控制目标。
 *                   浏览器那边照跑完整 RTT 协议，能力最全（多通道/丢包/下行）。
 *      · jlink   —— J-Link 的 RTT telnet(19021) 字节流转发（ch0 全双工）；
 *                   或用 JLinkRTTLogger 落文件后 tail（只读，可拿其它通道）。
 *
 * 用法：
 *   node bridge/rtt-bridge.mjs --target stm32f103
 *   node bridge/rtt-bridge.mjs --target esp32s31 --attach        # 复用已在跑的 OpenOCD
 *   node bridge/rtt-bridge.mjs --jlink-attach                    # 连本机 19021 的 J-Link RTT
 * 选项见 --help。
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0';

/* ============================ 参数 ============================ */
function parseArgs(argv){
  const a = { port: 17321, host: '127.0.0.1', root: path.join(__dirname, '..'), target: '', attach: false,
              openocd: '', scripts: '', tclPort: 6666, jlinkAttach: false, jlinkPort: 19021,
              jlinkLogger: '', jlinkDevice: '', jlinkChannel: 0, token: '' };
  for (let i = 0; i < argv.length; i++){
    const k = argv[i];
    const next = () => argv[++i];
    switch (k){
      case '--port': a.port = Number(next()); break;
      case '--host': a.host = next(); break;
      case '--root': a.root = path.resolve(next()); break;
      case '--target': a.target = next(); break;
      case '--attach': a.attach = true; break;
      case '--openocd': a.openocd = next(); break;
      case '--scripts': a.scripts = next(); break;
      case '--tcl-port': a.tclPort = Number(next()); break;
      case '--jlink-attach': a.jlinkAttach = true; break;
      case '--jlink-port': a.jlinkPort = Number(next()); break;
      case '--jlink-logger': a.jlinkLogger = next(); break;
      case '--jlink-device': a.jlinkDevice = next(); break;
      case '--jlink-channel': a.jlinkChannel = Number(next()); break;
      case '--token': a.token = next(); break;
      case '-h': case '--help': a.help = true; break;
      default: console.warn('忽略未知参数：' + k);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help){
  console.log(`rtt-bridge ${VERSION}

用法: node rtt-bridge.mjs [选项]

  --port <n>            监听端口（默认 17321）
  --root <dir>          静态根目录（默认仓库根，网页从 http://127.0.0.1:<port>/ 打开）
  --target <名字>       目标配置名，见 bridge.config.json 的 targets（默认 stm32f103）
  --attach              复用已经在跑的 OpenOCD（不自己启动）
  --openocd <exe>       指定 openocd.exe（默认自动找 ESP-IDF 里那份）
  --scripts <dir>       OpenOCD 的 scripts 目录（默认跟着 openocd.exe 推断）
  --tcl-port <n>        OpenOCD Tcl RPC 端口（默认 6666）
  --jlink-attach        改当 J-Link 流桥：连本机 RTT telnet（默认 19021）
  --jlink-port <n>      J-Link RTT telnet 端口
  --jlink-logger <exe>  JLinkRTTLogger.exe 路径：自己拉一个只读的 RTT 日志流
  --jlink-device <名>   配合 --jlink-logger 用（如 STM32F103C8）
  --token <串>          WebSocket 简单口令（默认不校验；只监听本机）
`);
  process.exit(0);
}

/* ============================ 配置 ============================ */
function loadConfig(){
  const f = path.join(__dirname, 'bridge.config.json');
  const def = {
    targets: {
      stm32f103: {
        cfgs: ['interface/cmsis-dap.cfg', 'target/stm32f1x.cfg'],
        pre: ['cmsis-dap backend usb_bulk'],
        speed: 1000,
        note: 'CMSIS-DAP + STM32F103（SWD）',
      },
      esp32s31: {
        cfgs: ['board/esp32s31-builtin.cfg'],
        pre: [],
        speed: 0,
        note: 'ESP32-S31 板载 USB-Serial/JTAG',
      },
      esp32: {
        cfgs: ['board/esp32-wrover-kit.cfg'],
        pre: [],
        speed: 0,
        note: 'ESP32 通用',
      },
    },
  };
  if (!fs.existsSync(f)) return def;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...def, ...j, targets: { ...def.targets, ...(j.targets || {}) } };
  } catch (e){
    console.warn('bridge.config.json 解析失败，用默认配置：' + e.message);
    return def;
  }
}
const config = loadConfig();

function findOpenOcd(){
  if (args.openocd) return args.openocd;
  const home = os.homedir();
  const roots = [
    path.join(home, '.espressif', 'tools', 'openocd-esp32'),
    'C:\\Program Files\\OpenOCD', 'C:\\Program Files (x86)\\OpenOCD',
    '/usr/local/share/openocd', '/usr/share/openocd',
  ];
  for (const r of roots){
    if (!fs.existsSync(r)) continue;
    const hits = fs.readdirSync(r).map(d => path.join(r, d, 'openocd-esp32', 'bin', 'openocd.exe'))
      .concat(fs.readdirSync(r).map(d => path.join(r, d, 'bin', 'openocd.exe')))
      .filter(p => fs.existsSync(p)).sort();
    if (hits.length) return hits[hits.length - 1];
  }
  return 'openocd';
}

function openocdScripts(exe){
  if (args.scripts) return args.scripts;
  const base = path.dirname(path.dirname(exe));
  for (const c of [path.join(base, 'share', 'openocd', 'scripts'), path.join(base, 'scripts')]){
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/* ============================ WebSocket ============================ */
class WsConn {
  constructor(socket, onMessage, onClose){
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.alive = true;
    socket.on('data', d => {
      this.buf = Buffer.concat([this.buf, d]);
      this._parse();
    });
    socket.on('close', () => { this.alive = false; onClose?.(); });
    socket.on('error', () => { this.alive = false; onClose?.(); });
  }
  _parse(){
    for (;;){
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126){ if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127){
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n){ this.close(1009); return; }
        len = Number(big); off = 10;
      }
      if (len > 64 * 1024 * 1024){ this.close(1009); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload;
      if (masked){
        const mask = b.subarray(off, off + 4);
        payload = Buffer.from(b.subarray(off + 4, need));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      } else {
        payload = Buffer.from(b.subarray(off, need));
      }
      this.buf = b.subarray(need);
      if (opcode === 0x8){ this.close(); return; }
      if (opcode === 0x9){ this._frame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x0) this.onMessage?.(payload.toString('utf8'));
      // 二进制帧暂不用（协议里二进制都走 base64）
    }
  }
  _frame(opcode, payload){
    if (!this.alive) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536){ head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else {
      head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([head, payload])); } catch { this.alive = false; }
  }
  send(obj){ this._frame(0x1, Buffer.from(JSON.stringify(obj))); }
  close(code = 1000){
    if (!this.alive) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._frame(0x8, p);
    this.alive = false;
    try { this.socket.end(); } catch {}
  }
}

/* ============================ OpenOCD 后端 ============================ */
class OpenOcdBackend {
  constructor(){
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.child = null;
    this.mode = '';
    this.expr = [];
  }
  get name(){ return 'OpenOCD'; }

  async start(onLog){
    const attachOnly = args.attach;
    if (!attachOnly){
      const exe = findOpenOcd();
      const scripts = openocdScripts(exe);
      const t = config.targets[args.target];
      if (!t) throw new Error(`bridge.config.json 里没有目标 "${args.target}"`);
      const argv = ['-s', scripts];
      // 顺序要紧：interface cfg 之后立刻设后端（cmsis-dap backend usb_bulk），
      // 再加载 target cfg —— target cfg 会 transport select，之后就不能再改后端了
      const cfgs = t.cfgs || [];
      if (cfgs.length) argv.push('-f', path.join(scripts, cfgs[0]));
      for (const c of (t.pre || [])) argv.push('-c', c);
      for (const c of cfgs.slice(1)) argv.push('-f', path.join(scripts, c));
      if (t.speed) argv.push('-c', `adapter speed ${t.speed}`);
      argv.push('-c', 'init');
      onLog?.(`启动 OpenOCD：${exe} ${argv.join(' ')}`);
      this.child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child.stdout.on('data', d => onLog?.(String(d).trimEnd()));
      this.child.stderr.on('data', d => onLog?.(String(d).trimEnd()));
      this.child.on('exit', c => onLog?.(`OpenOCD 退出（code ${c}）`));
      // 等 Tcl RPC 端口起来
      await this._waitPort(args.tclPort, 20000);
      this.mode = 'spawn';
    } else {
      await this._waitPort(args.tclPort, 3000);
      this.mode = 'attach';
    }
    this.sock = await this._connect(args.tclPort);
    const v = await this.rpc('version');
    return { target: args.target, version: v.trim().split('\n')[0], mode: this.mode };
  }

  _waitPort(port, ms){
    const t0 = Date.now();
    return new Promise((res, rej) => {
      const tick = () => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => { s.destroy(); res(); });
        s.once('error', () => {
          s.destroy();
          if (Date.now() - t0 > ms) rej(new Error(`等 OpenOCD 的 ${port} 端口超时`));
          else setTimeout(tick, 250);
        });
      };
      tick();
    });
  }

  _connect(port){
    return new Promise((res, rej) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.setNoDelay(true); res(s); });
      s.once('error', rej);
    });
  }

  /** 发一条 Tcl RPC 命令：以 0x1A 结尾，读到 0x1A 结束 */
  rpc(line, timeout = 30000){
    return new Promise((res, rej) => {
      if (!this.sock) return rej(new Error('OpenOCD 未连接'));
      let done = false;
      const t = setTimeout(() => { if (!done){ done = true; cleanup(); rej(new Error(`OpenOCD 命令超时：${line}`)); } }, timeout);
      const onData = d => {
        this.buf = Buffer.concat([this.buf, d]);
        const i = this.buf.indexOf(0x1a);
        if (i >= 0 && !done){
          const out = this.buf.subarray(0, i).toString('utf8');
          this.buf = this.buf.subarray(i + 1);
          done = true; cleanup(); res(out);
        }
      };
      const onErr = e => { if (!done){ done = true; cleanup(); rej(e); } };
      const cleanup = () => { clearTimeout(t); this.sock.off('data', onData); this.sock.off('error', onErr); };
      this.sock.on('data', onData);
      this.sock.on('error', onErr);
      this.sock.write(line + '\n\x1a');
    });
  }

  static _words(text){
    const out = [];
    for (const tok of text.split(/\s+/)){
      if (!tok.startsWith('0x')) continue;
      out.push(parseInt(tok, 16) >>> 0);
    }
    return out;
  }

  /** 读内存：4 字节对齐且长度为 4 的倍数时用 32 位宽 + 文本字，否则退化成 8 位宽 */
  async readMem(addr, len){
    if (len <= 0) return new Uint8Array(0);
    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);
    let a = addr, left = len, o = 0;
    // 头部对齐
    if (a & 3){
      const n = Math.min(4 - (a & 3), left);
      const w = OpenOcdBackend._words(await this.rpc(`read_memory 0x${a.toString(16)} 8 ${n}`));
      for (let i = 0; i < n; i++) out[o + i] = w[i] & 0xff;
      a += n; left -= n; o += n;
    }
    while (left >= 4 && (left % 4 === 0 || left >= 8)){
      const n = Math.min(256, left >> 2);                    // 256 字 = 1KB/次（实测比大块更快）
      const t0 = Date.now();
      const text = await this.rpc(`read_memory 0x${a.toString(16)} 32 ${n}`, 20000);
      const w = OpenOcdBackend._words(text);
      if (w.length < n) throw new Error(`read_memory 只回来 ${w.length}/${n} 个字（@0x${a.toString(16)}）`);
      for (let i = 0; i < n; i++) dv.setUint32(o + i * 4, w[i], true);
      a += n * 4; left -= n * 4; o += n * 4;
      void t0;
    }
    if (left > 0){
      const w = OpenOcdBackend._words(await this.rpc(`read_memory 0x${a.toString(16)} 8 ${left}`));
      for (let i = 0; i < left; i++) out[o + i] = w[i] & 0xff;
    }
    return out;
  }

  async writeMem(addr, bytes){
    const data = Buffer.from(bytes);
    if (!data.length) return;
    const aligned = (addr % 4 === 0) && (data.length % 4 === 0);
    if (aligned){
      for (let o = 0; o < data.length; ){
        const n = Math.min(256, (data.length - o) >> 2);
        const words = [];
        for (let i = 0; i < n; i++) words.push('0x' + data.readUInt32LE(o + i * 4).toString(16));
        await this.rpc(`write_memory 0x${(addr + o).toString(16)} 32 {${words.join(' ')}}`, 20000);
        o += n * 4;
      }
    } else {
      for (let o = 0; o < data.length; ){
        const n = Math.min(64, data.length - o);
        const vals = [];
        for (let i = 0; i < n; i++) vals.push('0x' + data[o + i].toString(16).padStart(2, '0'));
        await this.rpc(`write_memory 0x${(addr + o).toString(16)} 8 {${vals.join(' ')}}`, 20000);
        o += n;
      }
    }
  }

  async halt(){ await this.rpc('halt'); }
  async go(){ await this.rpc('resume'); }
  async reset(){ await this.rpc('reset run', 20000); }

  stop(){
    try { this.sock?.destroy(); } catch {}
    try { if (this.child) this.child.kill(); } catch {}
    this.sock = null; this.child = null;
  }
}

/* ============================ J-Link 后端（流） ============================ */
class JLinkBackend {
  constructor(){
    this.sock = null;
    this.child = null;
    this.file = '';
    this.pos = 0;
    this.timer = null;
  }
  get name(){ return 'J-Link (RTT ch0 流)'; }

  async start(onLog, onData){
    if (args.jlinkLogger){
      const exe = args.jlinkLogger;
      this.file = path.join(os.tmpdir(), `rtt-jlink-${Date.now()}.log`);
      const argv = [];
      if (args.jlinkDevice) argv.push('-Device', args.jlinkDevice);
      argv.push('-If', 'SWD', '-Speed', '4000', '-RTTChannel', String(args.jlinkChannel));
      argv.push(this.file);
      onLog?.(`启动 ${exe} ${argv.join(' ')}`);
      this.child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child.stdout.on('data', d => onLog?.(String(d).trimEnd()));
      this.child.stderr.on('data', d => onLog?.(String(d).trimEnd()));
      fs.writeFileSync(this.file, '');
      this.timer = setInterval(() => {
        try {
          const st = fs.statSync(this.file);
          if (st.size > this.pos){
            const fd = fs.openSync(this.file, 'r');
            const buf = Buffer.alloc(st.size - this.pos);
            fs.readSync(fd, buf, 0, buf.length, this.pos);
            fs.closeSync(fd);
            this.pos = st.size;
            onData?.(buf);
          }
        } catch {}
      }, 100);
      return { mode: 'logger', file: this.file, note: 'JLinkRTTLogger 落文件后 tail：只读，可拿任意通道' };
    }
    // attach：连 J-Link 已经开着的 RTT telnet
    onLog?.(`连接 J-Link RTT telnet 127.0.0.1:${args.jlinkPort}`);
    this.sock = await new Promise((res, rej) => {
      const s = net.connect(args.jlinkPort, '127.0.0.1');
      s.once('connect', () => res(s));
      s.once('error', e => rej(new Error(`连不上 J-Link RTT telnet(${args.jlinkPort})：${e.message}。` +
        `请先用 JLinkRTTViewer（或带 RTT 的 JLink 会话）把它开起来，或用 --jlink-logger 模式。`)));
    });
    this.sock.on('data', d => onData?.(Buffer.from(d)));
    return { mode: 'attach', port: args.jlinkPort, note: 'J-Link RTT ch0 全双工（telnet）' };
  }

  async write(bytes){
    if (this.sock) this.sock.write(bytes);
    else throw new Error('JLinkRTTLogger 模式下只能读，不能写');
  }

  stop(){
    clearInterval(this.timer);
    try { this.sock?.destroy(); } catch {}
    try { if (this.child) this.child.kill(); } catch {}
    this.sock = null; this.child = null;
  }
}

/* ============================ HTTP + WS 服务 ============================ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p.endsWith('/')) p += 'index.html';
  const full = path.join(args.root, p);
  if (!full.startsWith(path.resolve(args.root))){
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err){
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + p);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

let backend = null;      // 当前后端（OpenOCD 或 J-Link）
let client = null;       // 当前 WS 连接（单客户端足够）

server.on('upgrade', (req, socket) => {
  if (!(req.url || '').startsWith('/ws')){ socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key){ socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const log = line => client?.send({ t: 'log', line: String(line) });
  const conn = new WsConn(socket, text => handle(conn, text, log), () => {
    backend?.stop(); backend = null; client = null;
  });
  client = conn;
  conn.send({ t: 'ready', version: VERSION, caps: ['mem', 'stream', 'target'],
              targets: Object.keys(config.targets), defaultTarget: args.target || 'stm32f103' });
  console.log('[ws] 网页已连接');
});

async function handle(conn, text, log){
  let m;
  try { m = JSON.parse(text); } catch { return; }
  const reply = obj => conn.send({ ...obj, id: m.id });
  try {
    switch (m.t){
      case 'hello':
        // 必须带 id 回（客户端是按 id 匹配请求/响应的）—— 第一版漏了，客户端等 hello 直接超时
        reply({ t: 'ready.ack', caps: ['mem', 'stream', 'target'], version: VERSION,
                targets: Object.keys(config.targets), defaultTarget: args.target || 'stm32f103' });
        break;

      case 'open': {
        backend?.stop();
        if (m.backend === 'jlink'){
          backend = new JLinkBackend();
          const info = await backend.start(log, buf => conn.send({ t: 'stream.data', data: buf.toString('base64') }));
          reply({ t: 'opened', info });
          console.log('[jlink] ' + JSON.stringify(info));
        } else {
          backend = new OpenOcdBackend();
          const info = await backend.start(log);
          reply({ t: 'opened', info });
          console.log('[openocd] ' + JSON.stringify(info));
        }
        break;
      }

      case 'mem.read': {
        if (!(backend instanceof OpenOcdBackend)) throw new Error('当前后端不支持读内存');
        const buf = await backend.readMem(m.addr, m.len);
        reply({ t: 'mem.data', data: Buffer.from(buf).toString('base64'), len: buf.length });
        break;
      }

      case 'mem.write': {
        if (!(backend instanceof OpenOcdBackend)) throw new Error('当前后端不支持写内存');
        await backend.writeMem(m.addr, Buffer.from(m.data || '', 'base64'));
        reply({ t: 'ok' });
        break;
      }

      case 'target.reset': await backend?.reset(); reply({ t: 'ok' }); break;
      case 'target.halt':  await backend?.halt();  reply({ t: 'ok' }); break;
      case 'target.go':    await backend?.go();    reply({ t: 'ok' }); break;

      case 'stream.write': {
        if (!(backend instanceof JLinkBackend)) throw new Error('当前后端不是流模式');
        await backend.write(Buffer.from(m.data || '', 'base64'));
        reply({ t: 'ok' });
        break;
      }

      default: reply({ t: 'error', message: '未知请求 ' + m.t });
    }
  } catch (e){
    reply({ t: 'error', message: String(e?.message || e) });
  }
}

server.listen(args.port, args.host, () => {
  console.log(`\nrtt-bridge ${VERSION}`);
  console.log(`  网页地址 : http://${args.host}:${args.port}/    （同源打开 → 没有本地网络访问权限提示）`);
  console.log(`  WebSocket: ws://${args.host}:${args.port}/ws`);
  console.log(`  静态根   : ${args.root}`);
  console.log(`  目标配置 : ${args.target || '(无，等网页指定)'}`);
  if (args.jlinkAttach){
    console.log(`  J-Link 流: 连 127.0.0.1:${args.jlinkPort}（先用 JLinkRTTViewer 把 RTT 会话开起来）`);
  } else {
    console.log(`  OpenOCD  : ${args.attach ? '复用已在跑的（--attach）' : findOpenOcd()}`);
  }
  console.log('\n按 Ctrl+C 退出\n');
});
