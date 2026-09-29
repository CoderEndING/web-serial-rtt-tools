/**
 * 「SPI/QSPI 桥」页的端到端自测（CDP，**不需要硬件**）：
 *   node tools/selftest/spi-bus-page.test.mjs    （等价：make test-spi-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个）。
 *
 * 跑的是**真页面对象**（`window.__tools.spi` 是桥页视图、`window.__tools.spiSession` 是共享会话）：
 * 切页 → 开假探针 → 读写配置 → 使能 → 发各种帧 → 回环自检 → 错误路径 → 统计对账。
 * 面板档 / 初始化步 / 屏相关的东西在 `spi-panel-page.test.mjs` 里测。
 * 每一步都断言"客观状态"（假探针里的计数、线上字节、表格内容），不看"像不像"。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const APP = process.env.APP || 'http://127.0.0.1:8899/index.html';
const URL_ = APP + '?demo=serial&t=' + Date.now();

setTimeout(() => { console.error('[WATCHDOG] 总超时'); process.exit(9); }, 180000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

async function ensureBrowser(){
  try { await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(2500) }); return; } catch {}
  console.log('  （CDP 浏览器没在跑，自己拉一个…）');
  const ps = spawn('pwsh', ['-NoProfile', '-File', join(root, 'tools', 'selftest', 'launch-browser.ps1'), '-Port', '9333', '-Url', APP],
    { stdio: 'ignore', detached: true });
  ps.unref();
  for (let i = 0; i < 90; i++){
    await sleep(500);
    try { await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(2000) }); return; } catch {}
  }
  throw new Error('等 CDP 浏览器超时');
}

await ensureBrowser();
const list = await (await fetch(CDP + '/json/list', { signal: AbortSignal.timeout(5000) })).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('CDP 里没有页面目标');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连不上')); });
let seq = 0; const pend = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)){ const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const send = (method, params = {}, t = 25000) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pend.delete(id)) rej(new Error(method + ' 超时')); }, t);
});

/** 在页面里求值（表达式字符串；异常会被抛出来） */
async function ev(expr){
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面里报错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
// 🚨 必须关缓存：python http.server 不发 Cache-Control，改完模块会拿到旧的（本仓库踩过）
try { await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
await send('Page.navigate', { url: URL_ });
console.log('目标: ' + URL_);

let ready = false;
for (let i = 0; i < 60; i++){
  await sleep(500);
  try { if (await ev('return !!window.__tools?.spi;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.spi 不存在）');

// ==================================================================== 1
console.log('== 1. 标签页与初始状态 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(Array.isArray(s.tabs) && s.tabs.includes('spi'), '标签栏里有 spi（桥页）');
  ok(s.tabs.includes('panel'), '标签栏里有 panel（屏页）');
  ok(s.tabs[s.tabs.length - 2] === 'spi' && s.tabs[s.tabs.length - 1] === 'panel',
     `最后两个标签是 桥 → 屏（${s.tabs.slice(-2).join(' → ')}）`, s.tabs.join(','));
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  ok(s.spi && s.spi.connected === false && s.spi.dataReady === false, '初始：未连接（HID 与数据面都空）');
  ok(s.panel && s.panel.connected === false, '屏页看到的是**同一个**会话（初始也未连接）');
  const logs = await ev(`return document.getElementById('sp-log').textContent;`);
  ok(/就绪/.test(logs), '日志区有启动提示');
}

// ==================================================================== 2
console.log('== 2. 切到 SPI/QSPI 桥页 + 开假探针 ==');
{
  await ev(`document.querySelector('#tabs .tab[data-tab="spi"]').click(); return true;`);
  await sleep(300);
  ok(await ev(`return document.getElementById('tab-spi').classList.contains('active');`), '点击标签后 #tab-spi 变成 active');
  const s = await ev(`
    const c = document.getElementById('sp-mock'); c.checked = true; c.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 800));
    return window.__tools.spi.summary();`);
  ok(s.mock === true && s.connected === true && s.dataReady === true, '勾上「用假探针」→ HID 与数据面都就绪');
  const info = await ev(`return document.getElementById('sp-info').textContent + ' | ' + document.getElementById('sp-usbinfo').textContent;`);
  ok(/假探针/.test(info), `侧栏写明是假探针：「${info}」`);
  const st = await ev(`return document.getElementById('sp-state').textContent;`);
  ok(/假探针/.test(st), `状态行 = ${st}`);
}

// ==================================================================== 3
console.log('== 3. 配置：读取 → 改写 → 回读对账 ==');
{
  await ev(`document.getElementById('sp-get').click(); await new Promise(r=>setTimeout(r,250)); return true;`);
  const def = await ev(`return { sclk: document.getElementById('sp-sclk').value, cs: document.getElementById('sp-cs').value,
    dc: document.getElementById('sp-pad-dc').value, rst: document.getElementById('sp-pad-rst').value }`);
  ok(def.sclk === '0', `默认 SCLK = 板级默认（select=${def.sclk}）`);
  ok(def.dc === '1' && def.rst === '2', `默认辅助脚 DC=PB11 / RST=PB12（${def.dc}/${def.rst}）`);

  const applied = await ev(`
    document.getElementById('sp-sclk').value = '40000000';
    document.getElementById('sp-mode').value = '0';
    document.getElementById('sp-cs').value = '0';
    document.getElementById('sp-thr').value = '100';
    document.getElementById('sp-clear').checked = true;
    document.getElementById('sp-set').click();
    await new Promise(r => setTimeout(r, 400));
    return { cfg: window.__tools.spiSession.cfg?.sclkHz, log: document.getElementById('sp-log').textContent };`);
  ok(applied.cfg === 40000000, `写配置后回读到 40 MHz（实际 ${applied.cfg}）`);
  ok(/回读对账一致/.test(applied.log), '日志明确写着「回读对账一致」（不靠状态字的 err 判断）');
}

// ==================================================================== 4
// ==================================================================== 5
console.log('== 5. 使能与状态 ==');
{
  const on = await ev(`
    document.getElementById('sp-enable').click();
    await new Promise(r => setTimeout(r, 400));
    return { en: window.__tools.spiSession.mockProbe.enabled, st: window.__tools.spi.summary() };`);
  ok(on.en === true, 'ENABLE → 假探针进入使能状态');
  const st = await ev(`
    await window.__tools.spiSession.pollStatus(true);
    return { sum: window.__tools.spi.summary(), word: document.getElementById('sp-word-text').textContent,
             sclk: document.getElementById('sp-sclk-actual').textContent };`);
  ok(st.sum.actualSclkHz === 40000000, `状态回读的实际 SCLK = 40 MHz（${st.sum.actualSclkHz}）`);
  ok(/MHz/.test(st.sclk), `页面把实际 SCLK 显示出来了：「${st.sclk}」`);
  ok(/已使能/.test(st.word), `状态字人话里含「已使能」：「${st.word}」`);
}

// ==================================================================== 6
console.log('== 6. 通用帧：XFER 回环 + PING/GPIO/DELAY/RESET ==');
{
  const x = await ev(`
    document.getElementById('sp-x-cmd').value = '0x2C';
    document.getElementById('sp-x-cmden').checked = true;
    document.getElementById('sp-x-lines').value = '1';
    document.getElementById('sp-x-tx').value = 'aa bb cc dd';
    document.getElementById('sp-x-rx').value = '4';
    document.getElementById('sp-x-rsp').checked = true;
    document.getElementById('sp-x-send').click();
    await new Promise(r => setTimeout(r, 400));
    const spi = window.__tools.spiSession;
    return { wire: spi.mockProbe.wire.map(w => [...w]), log: document.getElementById('sp-log').textContent };`);
  const last = x.wire[x.wire.length - 1] || [];
  ok(last.join(',') === '170,187,204,221', `XFER 的 tx 真的落到线上（${last.join(' ')}）`);
  ok(/XBAR|OK/.test(x.log) || /4 B/.test(x.log), '日志里能看到应答与读回长度');

  const simple = await ev(`
    document.getElementById('sp-f-ping').click(); await new Promise(r=>setTimeout(r,150));
    document.getElementById('sp-f-cs-low').click(); await new Promise(r=>setTimeout(r,150));
    document.getElementById('sp-f-cs-high').click(); await new Promise(r=>setTimeout(r,150));
    document.getElementById('sp-f-gpio-line').value = '0';
    document.getElementById('sp-f-gpio-level').value = '1';
    document.getElementById('sp-f-gpio').click(); await new Promise(r=>setTimeout(r,150));
    document.getElementById('sp-f-delay').value = '2000';
    document.getElementById('sp-f-delay-send').click(); await new Promise(r=>setTimeout(r,150));
    document.getElementById('sp-f-reset-low').value = '5';
    document.getElementById('sp-f-reset-post').value = '20';
    document.getElementById('sp-f-reset-send').click(); await new Promise(r=>setTimeout(r,250));
    const p = window.__tools.spiSession.mockProbe;
    return { log: p.wireLog.slice(-6), delays: p.delays, cs: p.cs, framesOk: p.stats.framesOk };`);
  ok(simple.log.some(l => /GPIO dc=1/.test(l)), 'GPIO 帧改到了 DC 电平');
  ok(simple.delays.includes(2), `DELAY 帧的 2000 µs → 2 ms 被探针记下（${simple.delays.join(',')}）`);
  ok(simple.delays.some(d => d === 25), 'RESET 帧折算成 5+20 ms（非阻塞登记）');
  ok(simple.framesOk >= 7, `这一节 7 个帧都执行成功（frames_ok=${simple.framesOk}）`);
  ok(simple.cs === false, 'CS 帧后处于释放状态');
}

// ==================================================================== 7
console.log('== 7. 回环自检（假探针自带回环）==');
{
  const lb = await ev(`
    document.getElementById('sp-lb-lens').value = '1,2,32,99,100,101,256,492';
    document.getElementById('sp-lb-lines').value = '1';
    document.getElementById('sp-lb-dma').checked = true;
    document.getElementById('sp-lb-run').click();
    for (let i = 0; i < 100 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 200));
    return { sum: document.getElementById('sp-lb-sum').textContent,
             rows: [...document.querySelectorAll('#sp-lb-body tr')].map(tr => tr.textContent),
             log: document.getElementById('sp-log').textContent };`);
  ok(lb.rows.length === 16, `8 个长度 × 2 条路径 = 16 行结果（实际 ${lb.rows.length}）`);
  ok(lb.sum === '16/16 PASS', `回环自检全部通过：${lb.sum}`, lb.rows.slice(0, 3).join(' / '));
  ok(/回环自检完成：16\/16 PASS/.test(lb.log), '日志里有总结行');
}

// ==================================================================== 8
console.log('== 8. 错误路径：必须看得见，不能静默 ==');
{
  // ① 没接跳线（读回 0x00）→ 回环必须 FAIL，且表格标红
  const bad = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    p.faults.loopback = false;
    document.getElementById('sp-lb-lens').value = '8';
    document.getElementById('sp-lb-dma').checked = false;
    document.getElementById('sp-lb-run').click();
    for (let i = 0; i < 100 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 200));
    const rows = [...document.querySelectorAll('#sp-lb-body tr')];
    p.faults.loopback = true;
    return { sum: document.getElementById('sp-lb-sum').textContent, cls: rows[0]?.className, n: rows.length };`);
  ok(bad.n === 1 && bad.cls === 'bad' && bad.sum === '0/1 PASS', `没接跳线 → FAIL 且行标红（${bad.sum} / class=${bad.cls}）`);

  // ② 桥失能后发帧 → 真固件 NAK，页面要报出来（不是"什么都没发生"）
  const off = await ev(`
    document.getElementById('sp-disable').click();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('sp-f-ping').click();
    await new Promise(r => setTimeout(r, 500));
    return { enabled: window.__tools.spiSession.mockProbe.enabled, log: document.getElementById('sp-log').textContent,
             errs: window.__tools.spiSession.transport.errors };`);
  ok(off.enabled === false, 'DISABLE 生效');
  ok(/没使能|NAK|写超时/.test(off.log) && off.errs >= 1, `失能后发帧被如实报错（transport.errors=${off.errs}）`);

  // ③ 丢应答 → 超时分支（不悬挂、不静默）
  const drop = await ev(`
    document.getElementById('sp-enable').click(); await new Promise(r => setTimeout(r, 300));
    const p = window.__tools.spiSession.mockProbe;
    p.faults.dropRsp = true;
    document.getElementById('sp-f-ping').click();
    await new Promise(r => setTimeout(r, 1800));
    p.faults.dropRsp = false;
    return document.getElementById('sp-log').textContent;`);
  ok(/应答超时/.test(drop), '丢应答 → 页面报「应答超时」（不静默挂住）');
}

// ==================================================================== 9
console.log('== 9. 统计对账（页面显示 = 探针计数）==');
{
  // 先造一个**真正的协议层错误**（收发不等长 → RANGE）：验证 frames_err 会涨
  const proto = await ev(`
    const spi = window.__tools.spiSession;
    const P = await import('/app/spi/protocol.js');
    const before = spi.mockProbe.stats.framesErr;
    const r = await spi.sendFrames([{ type: P.T.XFER, payload: P.xferPayload({ tcfg: 0, tx: new Uint8Array(2), rxLen: 3 }),
                                      flags: P.F.RSP, label: '不等长' }], { quiet: true });
    return { status: r.rsps[0]?.status, before, after: spi.mockProbe.stats.framesErr };`);
  ok(proto.status === 4 && proto.after === proto.before + 1,
     `协议层错误会被记账：RANGE(4) → frames_err ${proto.before}→${proto.after}`);

  const cmp = await ev(`
    const bus = window.__tools.spi, spi = window.__tools.spiSession;
    await spi.pollStatus(true);
    const s = bus.summary(), p = spi.mockProbe.stats;
    return { pageOk: s.framesOk, probeOk: p.framesOk, pageErr: s.framesErr, probeErr: p.framesErr,
             bytesTx: s.bytesTx, probeTx: p.bytesTx,
             dom: { ok: document.getElementById('sp-c-ok').textContent, err: document.getElementById('sp-c-err').textContent,
                    tx: document.getElementById('sp-c-tx').textContent } };`);
  ok(cmp.pageOk === cmp.probeOk, `frames_ok 对账一致（页面 ${cmp.pageOk} = 探针 ${cmp.probeOk}）`);
  ok(cmp.pageErr === cmp.probeErr, `frames_err 对账一致（${cmp.pageErr}）`);
  ok(cmp.bytesTx === cmp.probeTx, `bytes_tx 对账一致（${cmp.bytesTx} B）`);
  ok(cmp.dom.ok === String(cmp.pageOk), `计数器渲染到 DOM（ok=${cmp.dom.ok} · tx=${cmp.dom.tx}）`);
  ok(cmp.pageErr === 1,
     'frames_err **只**由协议层错误产生：回环失配是应用层判定、失能 NAK 在传输层、丢应答不改帧执行结果 —— 三类都不该混进这个计数');
}

// ==================================================================== 10
console.log('== 10. 收尾：放掉探针（别的页签要用）==');
{
  const done = await ev(`
    await window.__tools.spiSession.teardown();
    await new Promise(r => setTimeout(r, 200));
    return window.__tools.spi.summary();`);
  ok(done.connected === false && done.dataReady === false, 'teardown 后 HID 与数据面都放掉了');
  const err = await ev(`return window.__tools.summary().errors;`);
  ok(err.length === 0, '整场跑完页面无未捕获错误', JSON.stringify(err));
}

console.log(`\n${fail ? '❌' : '✅'} spi-bus-page.test: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
