/**
 * 「RTT → CDC 转发」面板（挂在**终端**页）。
 *
 * 干什么：akaLinkPro 探针自己就能轮询目标的 RTT 控制块、把数据塞进它的 CDC 虚拟串口，
 * 于是主机只要读一个 COM 口就能拿到 RTT —— 不用每轮三次 USB 往返（实测 2.5~3 MB/s）。
 * 开启/停止/地址这些参数走探针的**自定义 HID**（0x31 命令），协议在 app/hid/probe.js。
 *
 * 流程：连接探针(HID) → 填 RTT 地址（手填，或载入 ELF 自动解析 _SEGGER_RTT）→ 启动转发
 *      → 回到「串口助手」打开这颗探针的 CDC 口（同一个 VCOM）就能看到 RTT 数据。
 */
import { $, setStatus, debounce } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { findSymbol } from '../rtt/elf.js';
import { AkaLinkHid, startRcText, START_PENDING } from './probe.js';
import { MockAkaLinkHid } from './mock.js';

const CLOCK_OPTIONS = [
  { v: '', label: '不改（用探针当前档位）' },
  { v: '20000000', label: '20 MHz' },
  { v: '30000000', label: '30 MHz' },
  { v: '36000000', label: '36 MHz' },
  { v: '45000000', label: '45 MHz（出厂默认）' },
  { v: '60000000', label: '60 MHz（更快，偶发抖动）' },
];

const hex = n => '0x' + (n >>> 0).toString(16);
const kb = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 102400 ? 1 : 0) + ' KB';

export class RttCdcView {
  constructor(){
    this.dev = new AkaLinkHid();
    this.mock = null;
    this.info = null;
    this.last = null;         // 最近一次 status
    this._elfInput = null;
    this._bound = false;
  }

  init(){
    if (this._bound) return;
    this._bound = true;

    this._elfInput = document.createElement('input');
    this._elfInput.type = 'file';
    this._elfInput.accept = '.elf,.axf,.out,.bin';
    this._elfInput.hidden = true;
    document.body.appendChild(this._elfInput);

    $('h-clock').innerHTML = CLOCK_OPTIONS.map(o => `<option value="${o.v}">${o.label}</option>`).join('');
    store.bind($('h-addr'), 'hid.addr');
    store.bind($('h-size'), 'hid.size');
    store.bind($('h-chan'), 'hid.chan');
    store.bind($('h-clock'), 'hid.clock');

    $('h-connect').addEventListener('click', () => this.connect());
    $('h-reconnect').addEventListener('click', () => this.reconnect());
    $('h-elf').addEventListener('click', () => this._elfInput.click());
    this._elfInput.addEventListener('change', () => this.loadElf());
    $('h-start').addEventListener('click', () => this.start());
    $('h-auto').addEventListener('click', () => this.autostart());
    $('h-stop').addEventListener('click', () => this.stop());
    $('h-refresh').addEventListener('click', () => this.refresh());
    $('h-clock').addEventListener('change', debounce(() => this.applyClock(), 60));

    // ?hid=mock：没插硬件也能把这张面板走一遍（自测/演示）
    if (new URLSearchParams(location.search).get('hid') === 'mock') this.useMock();

    this.dev.onDisconnect = () => this.render({ error: '探针断开了（USB 被拔？）' });
    this.render();
    // 之前授权过的探针：静默接上（没授权就安静地保持未连接）
    if (!this.mock && AkaLinkHid.supported()) this.reconnect({ silent: true });
  }

  useMock(){
    this.mock = new MockAkaLinkHid();
    this.dev = this.mock;
    this.render();
    return this.mock;
  }

  // ---------------------------------------------------------------- 连接
  async connect(){
    try {
      await this.dev.request();
      this.info = await this.dev.info();
      this.render();
      toast(`已连接：${this.dev.label}${this.info.fw ? ' · FW ' + this.info.fw : ''}`, 'ok');
    } catch (e){
      this.render({ error: e?.message || String(e) });
      toast('连接探针失败：' + (e?.message || e), 'err');
    }
  }

  async reconnect({ silent = false } = {}){
    if (this.mock) return;
    try {
      await this.dev.reconnect();
      this.info = await this.dev.info();
      this.render();
      if (!silent) toast(`已重连：${this.dev.label}`, 'ok');
    } catch (e){
      if (!silent) toast('重连失败：' + (e?.message || e), 'err');
      else this.render();
    }
  }

  // ---------------------------------------------------------------- 参数
  params(){
    const num = (id, dflt) => {
      const v = $(id).value.trim();
      const n = v === '' ? dflt : (v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10));
      return Number.isFinite(n) ? n : dflt;
    };
    return {
      addr: num('h-addr', 0),
      size: num('h-size', 0),
      channel: num('h-chan', 0),
      clockHz: Number($('h-clock').value) || 0,
    };
  }

  persist(){
    store.set('hid.addr', $('h-addr').value);
    store.set('hid.size', $('h-size').value);
    store.set('hid.chan', $('h-chan').value);
    store.set('hid.clock', $('h-clock').value);
  }

  /** SWD 时钟那条是运行时调参（action 7），改了立刻发；没连就只记着 */
  async applyClock(){
    this.persist();
    if (this.mock) return;
    const { clockHz } = this.params();
    if (!this.dev.connected || !clockHz) return;
    try {
      await this.dev.configure({ clockHz });
      toast(`探针 SWD 时钟已设为 ${clockHz / 1e6} MHz`, 'ok');
      await this.refresh();
    } catch (e){ toast('调时钟失败：' + (e?.message || e), 'err'); }
  }

  // ---------------------------------------------------------------- 启停
  async start(){
    const p = this.params();
    try {
      if (p.clockHz && !this.mock) await this.dev.configure({ clockHz: p.clockHz });
      const before = this.last?.startRc ?? 0;
      await this.dev.start(p);
      this.persist();
      await this._settle(before);
    } catch (e){
      this.render({ error: e?.message || String(e) });
      toast('启动转发失败：' + (e?.message || e), 'err');
    }
  }

  async autostart(){
    try {
      const before = this.last?.startRc ?? 0;
      await this.dev.autostart();
      await this._settle(before);
    } catch (e){
      this.render({ error: e?.message || String(e) });
      toast('自动搜控制块失败：' + (e?.message || e), 'err');
    }
  }

  async stop(){
    try {
      const r = await this.dev.stop();
      this.last = r.status;
      this.render();
      toast('已停止转发（CDC 口切回 UART）', 'ok');
    } catch (e){
      this.render({ error: e?.message || String(e) });
    }
  }

  async refresh(){
    try {
      const r = await this.dev.status();
      this.last = r.status;
      this.render();
    } catch (e){
      this.render({ error: e?.message || String(e) });
    }
  }

  /**
   * 启动是**排队**的（探针在主循环里做 SWD），所以这里轮询几次等结果：
   * 起来 / 返回码变了 / 超时，三种情况都会停。
   */
  async _settle(prevRc, timeout = 3000){
    const t0 = Date.now();
    for (;;){
      const r = await this.dev.status();
      this.last = r.status;
      this.render();
      const st = r.status;
      if (st.running && st.cbAddr) break;
      if (st.startRc !== 0 && st.startRc !== START_PENDING && st.startRc !== prevRc) break;
      if (Date.now() - t0 > timeout) break;
      await new Promise(res => setTimeout(res, 150));
    }
    const st = this.last;
    if (st?.running && st.cbAddr) toast(`转发已启动 · 控制块 ${hex(st.cbAddr)} · 档位 ${st.swdMhz} MHz`, 'ok', 5000);
    else if (st?.running) toast(`桥跑起来了，但还没找到控制块（读错 ${st.rdErr}）—— 地址窗口 / SWD 接线 / 目标供电检查一下`, 'warn', 8000);
    else if (st?.startRc === START_PENDING) toast('启动还在排队（探针还没给出结果，稍后点「刷新状态」看看）', 'warn', 6000);
    else if (st?.startRc) toast('启动失败：' + startRcText(st.startRc), 'err', 6000);
  }

  // ---------------------------------------------------------------- ELF
  async loadElf(){
    const f = this._elfInput.files?.[0];
    this._elfInput.value = '';
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const sym = findSymbol(buf, '_SEGGER_RTT');
      if (!sym){
        toast(`${f.name} 里没有 _SEGGER_RTT 符号（strip 过？）→ 只能用「自动搜控制块」`, 'warn', 6000);
        return;
      }
      $('h-addr').value = hex(sym.addr);
      // 已知确切地址就不用扫 64 KB：给个 4 KB 窗口，既不越界也留点余量（固件是 512B 重叠窗块读）
      $('h-size').value = '0x1000';
      this.persist();
      this.render();
      toast(`从 ELF 拿到 _SEGGER_RTT = ${hex(sym.addr)}（${sym.size} B）→ 搜索长度设为 0x1000`, 'ok', 6000);
    } catch (e){
      toast('读 ELF 失败：' + (e?.message || e), 'err');
    }
  }

  // ---------------------------------------------------------------- 渲染
  render({ error } = {}){
    const dev = this.dev;
    // 第一行：设备信息
    if (error && !dev.connected) setStatus($('h-info'), error, 'err');
    else if (!dev.connected) setStatus($('h-info'), '未连接（点「连接探针」在弹框里选 akaLinkPro）', '');
    else{
      const i = this.info || {};
      setStatus($('h-info'), `已连接：${dev.label}${i.fw ? ' · FW ' + i.fw : ''}${i.sn ? ' · SN ' + i.sn : ''}`, 'ok');
    }

    // 第二行：桥的状态
    const st = this.last;
    const el = $('h-state');
    if (error && dev.connected) setStatus(el, error, 'err');
    else if (!st) setStatus(el, dev.connected ? '未启动' : '—', '');
    else if (st.running && !st.cbAddr){
      // 桥跑起来了但还没找到控制块：地址不对 / 接线或供电问题（探针会一直扫，读错在涨）
      setStatus(el, `运行中 · 还没找到 RTT 控制块（读错 ${st.rdErr} / RdOff 错 ${st.wrErr}`
        + ` · 档位 ${st.swdMhz} MHz）—— 地址窗口给对了吗？Cortex-M7 要给 AXI SRAM；再查 SWD 接线与目标供电`, 'err');
    }
    else if (st.running){
      setStatus(el, `运行中 · 控制块 ${hex(st.cbAddr)} · 上行缓冲 ${hex(st.upAddr)} · 通道 ${st.channel}`
        + ` · 已搬运 ${kb(st.moved)}（${st.transfers} 次）· 轮询 ${st.polls}`
        + ` · 读错 ${st.rdErr} / RdOff 错 ${st.wrErr} · 档位 ${st.swdMhz} MHz`
        + (st.discard ? ' · 丢弃模式' : ''), 'ok');
    } else if (st.startRc === START_PENDING){
      setStatus(el, '正在启动…（探针还在排队搜控制块）', '');
    } else if (st.startRc){
      setStatus(el, `未运行 · 上次启动失败：${startRcText(st.startRc)}`, 'err');
    } else {
      setStatus(el, '未运行（点「启动转发」或「自动搜控制块」）', '');
    }
    return this.summary();
  }

  /** 自检用 */
  summary(){
    const st = this.last;
    return {
      supported: AkaLinkHid.supported(),
      mock: !!this.mock,
      connected: this.dev.connected,
      label: this.dev.connected ? this.dev.label : '',
      running: !!st?.running,
      cbAddr: st ? hex(st.cbAddr) : '',
      moved: st?.moved ?? 0,
      startRc: st?.startRc ?? null,
      state: $('h-state').textContent,
      info: $('h-info').textContent,
    };
  }
}
