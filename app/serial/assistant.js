/**
 * 串口助手（SSCOM 核心功能的网页版）。
 * 功能：端口/参数、ASCII-HEX 收发、时间戳、定时发送、快捷发送(Alt+1~5)、
 *      收发统计、保存接收数据、DTR/RTS、显示发送回显。
 */
import { $, seg, setFlag, setStatus } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { RxBuffer } from '../core/rxview.js';
import { Counter } from '../core/stats.js';
import { SerialSession } from './session.js';
import { parseHex, textToBytes, EOL_LABEL } from '../core/hex.js';
import { bytes as fBytes, rate as fRate, fileStamp, download } from '../core/format.js';
import { DemoPort, demoEnabled } from './demo.js';

const EOL_BYTES = { none: '', crlf: '\r\n', cr: '\r', lf: '\n' };
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

export class Assistant {
  constructor(session){
    this.s = session;
    this.ports = [];
    this.rx = null;
    this.rxc = new Counter();
    this.txc = new Counter();
    this.timer = null;
    this.echo = false;
  }

  init(){
    this.rx = new RxBuffer($('s-rx'), { maxLines: 4000, maxRaw: 2 * 1024 * 1024 });
    this.demo = demoEnabled();

    if (!SerialSession.supported() && !this.demo){
      setStatus($('s-note'), '这个浏览器没有 Web Serial（请用桌面版 Chrome / Edge 打开）。', 'err');
      $('s-open').disabled = true; $('s-pick').disabled = true;
    }

    // ---------- 接收区显示设置 ----------
    const rxm = store.get('serial.rxmode', 'ascii');
    this.rx.setMode(rxm);
    seg(document.querySelector('[data-group=rxmode]'), rxm, v => { this.rx.setMode(v); store.set('serial.rxmode', v); });

    this._chk($('s-ts'), 'serial.ts', v => this.rx.setTimestamps(v, $('s-tsabs').checked));
    this._chk($('s-tsabs'), 'serial.tsabs', v => this.rx.setTimestamps($('s-ts').checked, v));
    this._chk($('s-autoscroll'), 'serial.autoscroll', v => this.rx.setAutoscroll(v));
    this._chk($('s-echo'), 'serial.echo', v => { this.echo = v; });

    // ---------- 串口参数 ----------
    for (const [el, key] of [[$('s-baud'), 'serial.baud'], [$('s-databits'), 'serial.databits'],
                             [$('s-stopbits'), 'serial.stopbits'], [$('s-parity'), 'serial.parity'],
                             [$('s-flow'), 'serial.flow']]) store.bind(el, key);
    this._chk($('s-dtr'), 'serial.dtr', v => this.s.setSignals({ dtr: v }).catch(() => {}));
    this._chk($('s-rts'), 'serial.rts', v => this.s.setSignals({ rts: v }).catch(() => {}));

    // ---------- 发送设置 ----------
    const txm = store.get('serial.txmode', 'ascii');
    this.txSeg = seg(document.querySelector('[data-group=txmode]'), txm, v => store.set('serial.txmode', v));
    store.bind($('s-eol'), 'serial.eol');
    this._chk($('s-timer'), 'serial.timer', () => this._armTimer());
    store.bind($('s-timer-ms'), 'serial.timerms');
    $('s-timer-ms').addEventListener('input', () => this._armTimer());

    // ---------- 按钮 ----------
    $('s-pick').addEventListener('click', () => this.pickPort());
    $('s-scan').addEventListener('click', () => this.refreshPorts());
    $('s-port').addEventListener('dblclick', () => this.renamePort());
    $('s-open').addEventListener('click', () => this.connect());
    $('s-close').addEventListener('click', () => this.s.close());
    $('s-send').addEventListener('click', () => this.send());
    $('s-clear').addEventListener('click', () => this.rx.clear());
    $('s-save').addEventListener('click', () => this.save());
    $('s-statclear').addEventListener('click', () => { this.rxc.reset(); this.txc.reset(); this._stats(); });
    $('s-pause').addEventListener('click', () => {
      const on = !this.rx.paused;
      this.rx.setPaused(on);
      $('s-pause').textContent = on ? '继续' : '暂停';
      $('s-pause').classList.toggle('primary', on);
    });

    // ---------- 快捷发送 ----------
    this._buildQuick();

    // ---------- 会话事件 ----------
    this.s.on('open', ({ opts, info }) => {
      setFlag($('conn-flag'), `已连接 ${info} @${opts.baudRate}`, 'on');
      $('s-open').disabled = true; $('s-close').disabled = false;
      $('s-scan').disabled = true; $('s-pick').disabled = true; $('s-port').disabled = true;
      setStatus($('s-err'), '', null);
      toast(`已打开串口 ${info} @ ${opts.baudRate} 8${opts.parity === 'none' ? 'N' : opts.parity === 'even' ? 'E' : 'O'}${opts.stopBits}`, 'ok');
      this._armTimer();
      this._stats();
    });
    this.s.on('close', ({ unexpected }) => {
      setFlag($('conn-flag'), '未连接');
      $('s-open').disabled = false; $('s-close').disabled = true;
      $('s-scan').disabled = false; $('s-pick').disabled = false; $('s-port').disabled = false;
      this._armTimer();
      if (unexpected) toast('串口已断开（设备被拔掉或占用）', 'warn');
      this._stats();
    });
    this.s.on('data', (b, t) => { this.rxc.add(b.length); this.rx.push(b, t); });
    this.s.on('tx', b => { this.txc.add(b.length); if (this.echo) this.rx.push(b, new Date(), '→ '); });
    this.s.on('error', e => setStatus($('s-err'), String(e?.message || e), 'err'));

    // ---------- 键盘 ----------
    $('s-tx').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); this.send(); }
    });
    window.addEventListener('keydown', e => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!$('tab-serial').classList.contains('active')) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 5 && this.quick?.[n - 1]){
        e.preventDefault();
        const body = this.quick[n - 1].body.value;
        if (!body.trim()){ toast(`快捷 ${n} 是空的`, 'warn'); return; }
        this.send(body);
      }
    });

    // ---------- 热插拔 ----------
    if (SerialSession.supported()){
      navigator.serial.addEventListener('connect', () => { this.refreshPorts(); toast('检测到新串口设备', 'ok'); });
      navigator.serial.addEventListener('disconnect', () => { this.refreshPorts(); });
    }

    this.refreshPorts();
    setInterval(() => this._stats(), 500);

    // 演示模式可以带 ?demo=serial&autoconnect=1 直接连上（给 Pages 首屏演示/截图用）
    try {
      if (this.demo && new URLSearchParams(location.search).get('autoconnect') === '1'){
        setTimeout(() => this.connect(), 200);
      }
    } catch {}
  }

  // ================= 内部工具 =================
  _chk(el, key, apply){
    store.bind(el, key, 'checked');
    el.addEventListener('change', () => apply(el.checked));
    apply(el.checked);
  }

  _portKey(p){
    // 浏览器不暴露 COM 号，只能用 VID:PID + 同型号序号做标识
    const d = SerialSession.describe(p);
    const same = this.ports.slice(0, this.ports.indexOf(p) + 1).filter(x => SerialSession.describe(x) === d).length;
    return `${d}#${same}`;
  }

  async refreshPorts(){
    if (this.demo){
      this.ports = [new DemoPort()];
      const sel = $('s-port');
      sel.innerHTML = '';
      sel.appendChild(new Option('演示串口（假设备，点「连接」即可）', '0'));
      setStatus($('s-note'), '当前是演示模式（?demo=serial）：这是页面内置的假串口，用来演示/自检，不是真硬件。', null);
      return;
    }
    this.ports = await SerialSession.listPorts();
    const sel = $('s-port');
    const prev = sel.value;
    sel.innerHTML = '';
    if (!this.ports.length){
      sel.appendChild(new Option('（没有已授权的串口 → 点「选择…」）', ''));
    } else {
      const lastDesc = store.get('serial.lastDesc', '');
      this.ports.forEach((p, i) => {
        const key = this._portKey(p);
        const alias = store.get('portAlias.' + key, '');
        const desc = SerialSession.describe(p);
        sel.appendChild(new Option(`${alias || `串口 ${i + 1}`} · ${desc}${desc === lastDesc ? ' ★' : ''}`, String(i)));
      });
      sel.value = (prev !== '' && this.ports[Number(prev)]) ? prev : '0';
    }
    // 端口名提示
    const descs = this.ports.map(p => SerialSession.describe(p)).join('，');
    setStatus($('s-note'), this.ports.length
      ? `已授权 ${this.ports.length} 个串口：${descs}（双击下拉框可起别名）。`
      : '还没有授权任何串口：点「选择…」在浏览器弹框里选一次。', null);
  }

  async pickPort(){
    try {
      await SerialSession.requestPort();
      await this.refreshPorts();
      toast('端口已授权，可以点「连接」了', 'ok');
    } catch (e){
      if (e?.name !== 'NotFoundError') toast('选择端口失败：' + e.message, 'err');
    }
  }

  renamePort(){
    const idx = Number($('s-port').value);
    const p = this.ports[idx];
    if (!p) return;
    const key = this._portKey(p);
    const cur = store.get('portAlias.' + key, '');
    const v = prompt(`给这个串口起个名字（${SerialSession.describe(p)}）：`, cur);
    if (v === null) return;
    store.set('portAlias.' + key, v.trim());
    this.refreshPorts();
  }

  async connect(){
    const idx = Number($('s-port').value);
    const port = this.ports[idx];
    if (!port){ toast('先点「选择…」授权一个串口', 'warn'); return; }
    try {
      await this.s.open(port, {
        baudRate: Number($('s-baud').value) || 115200,
        dataBits: Number($('s-databits').value) || 8,
        stopBits: Number($('s-stopbits').value) || 1,
        parity: $('s-parity').value,
        flowControl: $('s-flow').value,
        dtr: $('s-dtr').checked,
        rts: $('s-rts').checked,
      });
      store.set('serial.lastDesc', SerialSession.describe(port));
      this.refreshPorts();
    } catch (e){
      setStatus($('s-err'), '打开失败：' + e.message, 'err');
      toast('打开失败：' + e.message + '（端口被别的程序占着？）', 'err', 6000);
    }
  }

  /** 组包：文本/HEX + 行尾 */
  _build(rawText){
    const t = rawText ?? $('s-tx').value;
    if (!t.trim()) return { error: '发送内容为空' };
    let b;
    if (this.txSeg.value === 'hex'){
      const r = parseHex(t);
      if (r.error) return { error: r.error };
      b = r.bytes;
    } else {
      b = textToBytes(t);
    }
    const tail = EOL_BYTES[$('s-eol').value] || '';
    if (tail) b = concat(b, textToBytes(tail));
    if (!b.length) return { error: '发送内容为空' };
    return { bytes: b };
  }

  async send(rawText, opts = {}){
    const fromTimer = opts.fromTimer === true;
    if (!this.s.isOpen){ if (!fromTimer) toast('串口未打开', 'warn'); return false; }
    const { bytes, error } = this._build(rawText);
    if (error){ setStatus($('s-err'), error, 'err'); if (!fromTimer) toast(error, 'warn'); return false; }
    setStatus($('s-err'), '', null);
    try { await this.s.write(bytes); return true; }
    catch (e){ setStatus($('s-err'), '发送失败：' + e.message, 'err'); return false; }
  }

  sendText(t, opts = {}){ return this.send(t, opts); }

  _armTimer(){
    clearInterval(this.timer);
    this.timer = null;
    if (!$('s-timer').checked || !this.s.isOpen) return;
    const ms = Math.max(20, Number($('s-timer-ms').value) || 1000);
    this.timer = setInterval(() => this.send(undefined, { fromTimer: true }), ms);
  }

  _buildQuick(){
    const box = $('s-quick');
    box.innerHTML = '';
    this.quick = [];
    for (let i = 1; i <= 5; i++){
      const row = document.createElement('div');
      row.className = 'qrow';
      row.innerHTML = `<span class="qidx">${i}</span><input class="qlabel" placeholder="名称"><input class="qbody" placeholder="内容"><button title="发送（Alt+${i}）">发</button>`;
      const lab = row.querySelector('.qlabel');
      const body = row.querySelector('.qbody');
      const btn = row.querySelector('button');
      store.bind(lab, `quick.${i}.label`);
      store.bind(body, `quick.${i}.body`);
      btn.addEventListener('click', () => {
        if (!body.value.trim()){ toast(`快捷 ${i} 是空的`, 'warn'); return; }
        this.send(body.value);
      });
      box.appendChild(row);
      this.quick.push({ lab, body });
    }
  }

  _stats(){
    const now = performance.now();
    $('s-rxbytes').textContent = fBytes(this.rxc.total);
    $('s-rxframes').textContent = this.rxc.frames;
    $('s-rxrate').textContent = fRate(this.rxc.rate(now));
    $('s-txbytes').textContent = fBytes(this.txc.total);
    $('s-txframes').textContent = this.txc.frames;
    $('s-txrate').textContent = fRate(this.txc.rate(now));
    if (this.rx?.paused) $('s-pause').title = `暂停中，已缓存 ${fBytes(this.rx.bytes)}`;
  }

  save(){
    if (this.rx.empty){ toast('接收区没有数据', 'warn'); return; }
    const name = `serial-${fileStamp()}.txt`;
    download(name, this.rx.text());
    toast(`已保存 ${name}（${fBytes(this.rx.bytes)}）`, 'ok');
  }
}

export { EOL_LABEL };
