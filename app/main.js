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
import { DbgView } from './dbg/view.js';
import { SpiSession } from './spi/session.js';
import { SpiBusView } from './spi/bus-view.js';
import { SpiPanelView } from './spi/panel-view.js';
import { ProbeBus, closeProbeUsbDevices } from './core/probe-bus.js';
import { toast } from './ui/toast.js';
import { BUILD } from './core/build.js';

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
// 调试器（#dbg）：零安装的极简调试前端（暂停/单步/寄存器/内存/FPB 断点/命令行/RTT 同屏）
const dbg = new DbgView();
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
dbg.init();

initTabs(name => {
  if (name === 'terminal') requestAnimationFrame(() => terminal.onShow());
  if (name === 'rtt') requestAnimationFrame(() => rtt.onShow());
  if (name === 'rttcdc') requestAnimationFrame(() => stream.onShow());
  if (name === 'scope') requestAnimationFrame(() => scope.onShow());
  if (name === 'spi') requestAnimationFrame(() => spi.onShow());
  if (name === 'panel') requestAnimationFrame(() => panel.onShow());
  if (name === 'dbg') requestAnimationFrame(() => dbg.onShow());
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
  try {
    // 调试器：占着探针（可能还在单步/轮询），让位时一并断开
    if (dbg.session?.connected){ await dbg.disconnect(); done.push('调试会话'); }
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
    dbg: dbg?.summary?.() || null,
    vendor: 'serial-rtt-tools',
  };
}
const box = document.createElement('div');
box.id = 'selftest';
box.hidden = true;
document.body.appendChild(box);

// 烧录器抢探针前会通过它请别的页签让位（见上面的 probeBus）
flash.bus = probeBus;
// 调试器同理：连之前先请别的页签放掉探针（跨页签协调是必需的，不是锦上添花）
dbg.bus = probeBus;

window.__tools = { session, assistant, terminal, rtt, flash, gen, hid, stream, scope, spi, panel, dbg, spiSession, probeBus, summary, errors };

/**
 * 拆掉加载遮罩 —— 放在这里（所有 view 都 init 完、__tools 挂好之后）。
 * 🚨 顺序很重要：遮罩**必须最后摘**。之前出过一次"线上页面看着像坏的"：
 *    模块多（20+），走代理加载要好几秒，那期间下拉是空的、按钮点了没反应（事件还没绑上），
 *    用户以为是功能缺失 —— 遮罩能把这个阶段说清楚。
 */
{
  const mask = document.getElementById('boot-mask');
  if (mask) requestAnimationFrame(() => mask.remove());
}

/**
 * **构建标记 + 陈旧页面自检**（见 app/core/build.js 的注释）。
 *
 * 背景：GitHub Pages 对 HTML/JS 都发 `max-age=600`，推完修复后浏览器最长 10 分钟还在跑旧模块，
 * 而本机开发服务发 `no-store` 永远最新 —— 于是会看到"本地流畅、线上卡顿"这种**假象**。
 * 这里做两件事：① 把 BUILD 显示在标题栏（一眼可辨）；② 用 cache-buster 重新拉本文件比对，
 * 不一致就提示刷新（不能自动 reload 解决：`location.reload()` 仍可能命中 HTTP 缓存，
 * 得让用户 Ctrl+Shift+R）。
 */
{
  const self = new URL('./core/build.js', import.meta.url);
  const stamp = document.createElement('span');
  stamp.id = 'build-stamp';
  stamp.title = '当前页面加载的代码版本（GitHub Pages 有 10 分钟 HTTP 缓存：推完修复要硬刷新才生效）';
  stamp.style.cssText = 'margin-left:10px;opacity:.7;font-size:12px';
  stamp.textContent = BUILD.split(' ')[0] + ' 版';
  (document.querySelector('.topright') || document.querySelector('header') || document.body).appendChild(stamp);
  (async () => {
    try {
      const r = await fetch(self.href + '?t=' + Date.now(), { cache: 'no-store' });
      const txt = await r.text();
      if (!r.ok || !txt.includes(`BUILD = '${BUILD}'`)){
        stamp.textContent = '⚠ 页面是旧版，请 Ctrl+Shift+R';
        stamp.style.color = '#c60';
        stamp.title = '线上有更新的版本（HTTP 缓存最多 10 分钟）；按 Ctrl+Shift+R 强制刷新即可';
        console.warn('[build] 页面模块是旧版（HTTP 缓存）：线上已有更新，Ctrl+Shift+R 刷新');
        errors.push?.('页面是旧版（HTTP 缓存），建议 Ctrl+Shift+R');
      }
    } catch { /* 离线/取不到就算了，不影响功能 */ }
  })();
}

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
