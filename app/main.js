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

assistant.init();
terminal.init();
rtt.init();
flash.init();
gen.init();
hid.init();
stream.init();
scope.init();

initTabs(name => {
  if (name === 'terminal') requestAnimationFrame(() => terminal.onShow());
  if (name === 'rtt') requestAnimationFrame(() => rtt.onShow());
  if (name === 'rttcdc') requestAnimationFrame(() => stream.onShow());
  if (name === 'scope') requestAnimationFrame(() => scope.onShow());
  if (name === 'gen') requestAnimationFrame(() => gen.onShow());
});

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
    vendor: 'serial-rtt-tools',
  };
}
const box = document.createElement('div');
box.id = 'selftest';
box.hidden = true;
document.body.appendChild(box);

window.__tools = { session, assistant, terminal, rtt, flash, gen, hid, stream, scope, summary, errors };

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
