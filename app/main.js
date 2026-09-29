/**
 * 入口：把三个标签页接起来。
 * 串口助手与终端共用同一个串口会话（一个 COM 口只能被一个程序打开，
 * 两个标签是同一路数据的两种看法）；RTT 是独立的调试器会话。
 */
import { initTabs } from './ui/tabs.js';
import { SerialSession } from './serial/session.js';
import { Assistant } from './serial/assistant.js';
import { TerminalView } from './serial/terminal.js';
import { RttView } from './rtt/view.js';
import { FlashView } from './flash/view.js';
import { GenView } from './gen/view.js';
import { RttCdcView } from './hid/view.js';
import { RttCdcStreamView } from './hid/stream.js';
import { ScopeView } from './scope/view.js';
import { SpiSession } from './spi/session.js';
import { SpiBusView } from './spi/bus-view.js';
import { SpiPanelView } from './spi/panel-view.js';
import { ProbeBus, closeProbeUsbDevices } from './core/probe-bus.js';
import { toast } from './ui/toast.js';

// ---------- 错误收集（自检/排障用；平时看不见） ----------
const errors = [];
window.addEventListener('error', e => errors.push(`[error] ${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => errors.push(`[promise] ${e.reason?.message || e.reason}`));

const session = new SerialSession();
const assistant = new Assistant(session);
const terminal = new TerminalView(session);
const rtt = new RttView();
const flash = new FlashView();
const gen = new GenView();
const hid = new RttCdcView();
const stream = new RttCdcStreamView(session);
const scope = new ScopeView();
// SPI 桥：**一次连接，两页共用**（桥页管链路与通用帧，屏页管面板档/初始化/刷图）
const spiSession = new SpiSession();
const spi = new SpiBusView(spiSession);
const panel = new SpiPanelView(spiSession);

assistant.init();
terminal.init();
rtt.init();
flash.init();
gen.init();
hid.init();
stream.init();
scope.init();
spi.init();
panel.init();

initTabs(name => {
  if (name === 'terminal') requestAnimationFrame(() => terminal.onShow());
  if (name === 'rtt') requestAnimationFrame(() => rtt.onShow());
  if (name === 'rttcdc') requestAnimationFrame(() => stream.onShow());
  if (name === 'scope') requestAnimationFrame(() => scope.onShow());
  if (name === 'spi') requestAnimationFrame(() => spi.onShow());
  if (name === 'panel') requestAnimationFrame(() => panel.onShow());
  if (name === 'gen') requestAnimationFrame(() => gen.onShow());
});

/**
 * 跨标签页的探针协调：别的页签要占用探针时，本页把会话收干净（详见 core/probe-bus.js）。
 * 🚨 这是**必需**的一层，不是锦上添花：WebUSB 一个接口同时只能被一个连接认领，
 *    两个页签一起用时第二个只会拿到 `Unable to claim interface`（实测 reset 也救不回来）。
 *    以前只能让用户自己去关别的页签 —— 用户的原话是"有时候打开就卡住"。
 */
const probeBus = new ProbeBus('page');
probeBus.onRelease = async why => {
  const done = [];
  try {
    if (rtt.probe || rtt.bridge){ await rtt.disconnect(); done.push('RTT 会话'); }
  } catch { /* 让出失败也要继续让别的 */ }
  try {
    if (scope.running || scope.transport || (scope.hid && scope.hid !== scope.mockProbe)){
      await scope.releaseProbe(why || '别的页签要占用探针');
      done.push('J-Scope 会话');
    }
  } catch { /* 同上 */ }
  try {
    if (hid.last?.running){ await hid.stop(); done.push('RTT 转发（探针桥）'); }
  } catch { /* 同上 */ }
  try {
    // SPI 桥：既占 HID（配置）又占 USB 接口（数据面），别的页签要用探针时必须两边都放掉
    if (spiSession.connected || spiSession.dataReady){ await spiSession.teardown(); done.push('SPI 桥会话'); }
  } catch { /* 同上 */ }
  // 🚨 最后一步**必须**把本页签的探针 USB 句柄都关掉：视图那边可能早就"断开"了、
  //    只是引用丢了没 close()，而浏览器仍然认为接口被这个页签占着 —— 不关的话
  //    请求方那边怎么重试都认领不上（见 core/probe-bus.js 的 closeProbeUsbDevices）。
  const closed = await closeProbeUsbDevices();
  if (closed) done.push(`关闭 ${closed} 个残留 USB 句柄`);
  if (done.length) console.info('[probe-bus] 已让出：' + done.join('、'));
};
/** 让出的记录也让用户看得见（页签之间的事不该神神秘秘的） */
probeBus.log = s => { try { toast(s, 'warn', 4000); } catch {} };

document.getElementById('btn-help').addEventListener('click', () => document.getElementById('help').showModal());

// ---------- 自检摘要（无头验证 / 用户报障时可直接看） ----------
function summary(){
  return {
    ok: errors.length === 0,
    errors,
    serialSupported: SerialSession.supported(),
    webusbSupported: typeof navigator !== 'undefined' && 'usb' in navigator,
    xtermLoaded: !!window.Terminal,
    tabs: [...document.querySelectorAll('#tabs .tab')].map(t => t.dataset.tab),
    quickSlots: document.querySelectorAll('#s-quick .qrow').length,
    genFiles: (gen?.files || []).map(f => f.name),
    hid: hid?.summary?.() || null,
    stream: stream?.summary?.() || null,
    scope: scope?.summary?.() || null,
    spi: spi?.summary?.() || null,
    panel: panel?.summary?.() || null,
    vendor: 'serial-rtt-tools',
  };
}
const box = document.createElement('div');
box.id = 'selftest';
box.hidden = true;
document.body.appendChild(box);

// 烧录器抢探针前会通过它请别的页签让位（见上面的 probeBus）
flash.bus = probeBus;

window.__tools = { session, assistant, terminal, rtt, flash, gen, hid, stream, scope, spi, panel, spiSession, probeBus, summary, errors };

// ---------- 浏览器端端到端自检：?demo=serial&selftest=1 ----------
const q = new URLSearchParams(location.search);
if (q.get('selftest') === '1'){
  box.textContent = 'selftest: running';
  (async () => {
    try {
      const { runUiSelfTest } = await import('../tools/selftest/ui.selftest.mjs');
      const res = await runUiSelfTest(window.__tools);
      box.textContent = JSON.stringify({ ...summary(), selftest: res });
    } catch (e){
      box.textContent = JSON.stringify({ ...summary(), selftestError: String(e?.message || e) });
    }
  })();
} else {
  setTimeout(() => { box.textContent = JSON.stringify(summary()); }, 500);
}
