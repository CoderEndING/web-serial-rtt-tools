/**
 * 「SPI/QSPI 屏」页的端到端自测（CDP，**不需要硬件**）：
 *   node tools/selftest/spi-panel-page.test.mjs   （等价：make test-spi-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个）。
 *
 * 这一页的活儿是"把屏点亮"：**面板初始化代码**（贴 C 数组 → 解析 → 重放）、**图片/图案刷屏**、
 * 面板档与按屏套用推荐值。连同**共享会话**一起验：在屏页连接一次，桥页那边也得是同一个会话 ——
 * 这是拆页之后最容易退化的地方。
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

async function ev(expr){
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面里报错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
try { await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
/**
 * 🚨 **先把窗口提到前台**：窗口被最小化/完全遮住时 `document.visibilityState === 'hidden'`，
 * 而 Chrome **不为隐藏页面渲染 `<video>`** —— `play()` 照样 resolve，但 `currentTime` 不走、
 * `requestVideoFrameCallback` 一帧都不回调。症状是 §9b（视频那条路）"0 帧"，而同节的
 * GIF/PNG（ImageDecoder 那条路）一切正常 —— 极易误判成代码坏了（2026-10 本文件踩过，
 * 当时排查了半天才发现是窗口被遮住）。
 */
await send('Page.bringToFront').catch(() => {});
await send('Page.navigate', { url: URL_ });
console.log('目标: ' + URL_);

let ready = false;
for (let i = 0; i < 60; i++){
  await sleep(500);
  try { if (await ev('return !!window.__tools?.panel;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.panel 不存在）');

// ==================================================================== 1
console.log('== 1. 切到屏页 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(s.tabs.includes('spi') && s.tabs.includes('panel'), '桥页与屏页两个标签都在');
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  await ev(`document.querySelector('#tabs .tab[data-tab="panel"]').click(); return true;`);
  await sleep(300);
  ok(await ev(`return document.getElementById('tab-panel').classList.contains('active');`), '#tab-panel 变成 active');
  const preset = await ev(`return [...document.getElementById('pn-preset').options].map(o => o.value);`);
  ok(preset.join(',') === 'axs15352,st77916', `内置两块屏的推荐值都在（${preset.join('/')}）`);
}

// ==================================================================== 1b
console.log('== 1b. 布局（用户 2026-09-30 定的口径）：刷图置顶不可收起 / 解析表 360px / 右列滚动 ==');
{
  const L = await ev(`
    const main = document.querySelector('#tab-panel .main');
    const cards = [...main.querySelectorAll(':scope > fieldset')].map(f => f.id);
    const img = document.getElementById('pn-img-card'), code = document.getElementById('pn-code-card');
    const wrap = document.getElementById('pn-code-wrap');
    const cs = getComputedStyle(main);
    return { cards, hasImgFold: !!img.querySelector('.foldbtn'), hasCodeFold: !!code.querySelector('.foldbtn'),
             imgH: Math.round(img.getBoundingClientRect().height),
             tableH: Math.round(wrap.getBoundingClientRect().height),
             tableRows: document.querySelectorAll('#pn-code-body tr').length,
             over: cs.overflowY, canScroll: main.scrollHeight > main.clientHeight + 4,
             scrollH: main.scrollHeight, clientH: main.clientHeight,
             docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };`);
  ok(L.cards[0] === 'pn-img-card' && L.cards[1] === 'pn-log-card' && L.cards[2] === 'pn-code-card' && L.cards[3] === 'pn-read-card',
     `主区顺序 = 刷图 → 日志 → 面板初始化 → 读回（实测 ${L.cards.join(' → ')}；2026-10 用户要求：日志挪到初始化前、读回放在初始化后）`);
  ok(L.hasImgFold === false && L.hasCodeFold === true, '刷图那块**没有**收起按钮，初始化那块保留');
  ok(Math.abs(L.tableH - 360) <= 2, `解析表高度 = 360px（原来 120px 下限的 3 倍，实测 ${L.tableH}）`);
  ok(L.over === 'auto' && L.canScroll, `主区自己出纵向滚动条（overflow-y=${L.over}，${L.clientH} → ${L.scrollH}）`);
  ok(L.docOverflow === false, '整页没有横向滚动条');
  const log = await ev(`
    const card = document.getElementById('pn-log-card');
    return { folded: card.classList.contains('folded'), btn: card.querySelector('.foldbtn').textContent,
             h: Math.round(card.getBoundingClientRect().height), logH: Math.round(document.getElementById('pn-log').getBoundingClientRect().height) };`);
  ok(log.folded === false && log.logH > 100 && log.btn === '收起',
     `日志**默认展开**（用户 2026-09-30）：卡片 ${log.h}px / 日志区 ${log.logH}px，按钮写着「${log.btn}」`);

  // 表头吸顶（用户 2026-09-30："往下拉表头就上去了，看不到 byte 索引了"）
  const sticky = await ev(`
    const wrap = document.getElementById('pn-code-wrap');
    const th = document.querySelector('#pn-code-tab thead th');
    const ruler = document.getElementById('pn-code-ruler');
    const off = () => Math.round(th.getBoundingClientRect().top - wrap.getBoundingClientRect().top);
    const off0 = off();
    wrap.scrollTop = wrap.scrollHeight;
    await new Promise(r => setTimeout(r, 250));
    const off1 = off();
    const rulerVisible = ruler.getBoundingClientRect().top >= wrap.getBoundingClientRect().top - 1;
    const rowVisible = document.querySelectorAll('#pn-code-body tr')[20].getBoundingClientRect().top;
    wrap.scrollTop = 0;
    await new Promise(r => setTimeout(r, 100));
    return { off0, off1, rulerVisible, rowVisible: Math.round(rowVisible),
             pos: getComputedStyle(th).position, bg: getComputedStyle(th).backgroundColor };`);
  ok(sticky.pos === 'sticky' && Math.abs(sticky.off0) <= 1 && Math.abs(sticky.off1) <= 1 && sticky.rulerVisible,
     `表头（含字节标尺）吸顶：滚到底仍在容器顶部（偏移 ${sticky.off0} → ${sticky.off1}px，尺子可见=${sticky.rulerVisible}）`);
  ok(sticky.bg !== 'rgba(0, 0, 0, 0)', `吸顶表头有不透明背景（${sticky.bg}）—— 不然行会从底下透出来`);
}

// ==================================================================== 2
console.log('== 2. 共享会话：在屏页连接，桥页也是同一个会话 ==');
{
  const linked = await ev(`
    const c = document.getElementById('pn-mock'); c.checked = true; c.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    const bus = window.__tools.spi.summary(), pn = window.__tools.panel.summary();
    return { busConn: bus.connected, busData: bus.dataReady, pnConn: pn.connected, pnData: pn.dataReady,
             sameProbe: window.__tools.spiSession.mockProbe === window.__tools.spiSession.hid,
             busState: document.getElementById('sp-state').textContent,
             pnState: document.getElementById('pn-state').textContent };`);
  ok(linked.pnConn && linked.pnData, '屏页勾「用假探针」→ 屏页就绪');
  ok(linked.busConn && linked.busData, '**桥页也同时就绪**（一次连接，两页共用）');
  ok(linked.sameProbe === true, '假探针只有一个实例（HID 与数据面共用）');
  ok(/假探针/.test(linked.busState) && /假探针/.test(linked.pnState),
     `两页的状态行都更新了（桥「${linked.busState}」/ 屏「${linked.pnState}」）`);
}

// ==================================================================== 3
console.log('== 3. 面板档：默认 raw → 写 spi_dcx → 写 qspi ==');
{
  const def = await ev(`
    document.getElementById('pn-prof-get').click();
    await new Promise(r => setTimeout(r, 300));
    return { sel: document.getElementById('pn-profile').value, sum: document.getElementById('pn-sum-profile').textContent };`);
  ok(def.sel === '0' && /raw/.test(def.sum), `默认档 0 raw（select=${def.sel} · 摘要「${def.sum}」）`);

  const p1 = await ev(`
    document.getElementById('pn-profile').value = '1';
    document.getElementById('pn-deflines').value = '1';
    document.getElementById('pn-dcactive').checked = true;
    document.getElementById('pn-cshold').checked = true;
    document.getElementById('pn-prof-set').click();
    await new Promise(r => setTimeout(r, 400));
    return window.__tools.spiSession.profile;`);
  ok(p1.profile === 1 && p1.dcActiveHigh === true && p1.csHoldInStep === true,
     '档 1（spi_dcx）写进去了：DC 高=数据、翻 DC 保持 CS');

  const p2 = await ev(`
    document.getElementById('pn-profile').value = '2';
    document.getElementById('pn-qspiwr').value = '0x02';
    document.getElementById('pn-qspicolor').value = '0x32';
    document.getElementById('pn-qspiaddr').value = '3';
    document.getElementById('pn-prof-set').click();
    await new Promise(r => setTimeout(r, 400));
    return { prof: window.__tools.spiSession.profile, busProf: window.__tools.spi.summary().profile };`);
  ok(p2.prof.profile === 2 && p2.prof.qspiColorOpcode === 0x32 && p2.prof.qspiAddrBytes === 3,
     '档 2（qspi）写进去了：0x02 / 0x32 / 3 字节地址');
  ok(p2.busProf?.profile === 2, '桥页摘要里也是同一个档位（共享会话）');
}

// ==================================================================== 4
console.log('== 4. 按屏套用推荐值（档位 + SCLK + 引脚）==');
{
  const applied = await ev(`
    document.getElementById('pn-preset').value = 'st77916';
    document.getElementById('pn-preset').dispatchEvent(new Event('change'));
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    const s = window.__tools.spiSession;
    return { cfg: s.cfg, prof: s.profile, probe: { sclk: s.mockProbe.cfg.sclkHz, dc: s.mockProbe.cfg.padDc, rst: s.mockProbe.cfg.padRst },
             log: document.getElementById('pn-log').textContent,
             sum: { sclk: document.getElementById('pn-sum-sclk').textContent, pads: document.getElementById('pn-sum-pads').textContent } };`);
  ok(applied.prof.profile === 2, 'ST77916 → 档 2（qspi）');
  ok(applied.cfg.sclkHz === 40000000 && applied.probe.sclk === 40000000, 'ST77916 → SCLK 40 MHz（页面与探针都对）');
  // RST = **PA02**（2026-09-30 实测：PA02 抓得到复位波形、PA31 抓不到）。
  // 这条要紧：「重放前先复位」就发在这个脚上，默认值配错等于没复位。
  ok(applied.cfg.padDc === 0 && applied.cfg.padRst === 5 && applied.cfg.padBl === 11,
     `引脚按屏改了：DC=${applied.cfg.padDc}（不用）/ RST=PA02（pad ${applied.cfg.padRst}）/ BL=PA10（pad ${applied.cfg.padBl}）`);
  ok(/40 MHz/.test(applied.sum.sclk), `只读摘要显示 SCLK ${applied.sum.sclk}`);
  ok(/RST=PA02/.test(applied.sum.pads), `只读摘要显示引脚「${applied.sum.pads}」`);
  ok(/回读对账一致/.test(applied.log), '套用走的还是回读对账那条路（不靠状态字的 err）');

  const back = await ev(`
    document.getElementById('pn-preset').value = 'axs15352';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    const s = window.__tools.spiSession;
    return { prof: s.profile.profile, sclk: s.cfg.sclkHz, dc: s.cfg.padDc };`);
  ok(back.prof === 1 && back.sclk === 40000000 && back.dc === 5,
     `换回 AXS15352 → 档 1 + 40 MHz + DC=PA02（实测 ${back.prof}/${back.sclk}/${back.dc}）`);
}

// ==================================================================== 5
console.log('== 5. 面板初始化：内置示例 + 解析 + 表格 ==');
{
  const onLoad = await ev(`
    return { text: document.getElementById('pn-code-text').value.length,
             sum: document.getElementById('pn-code-sum').textContent,
             rows: window.__tools.panel.summary().rows,
             table: document.querySelectorAll('#pn-code-body tr').length };`);
  ok(onLoad.text > 500, `一进来就载入了内置示例（${onLoad.text} 字符）`);
  ok(onLoad.rows === 30 && onLoad.table === 32, `默认示例 = AXS15352 的 30 条 + 自动补的 2 条前缀 = 表格 32 行（${onLoad.rows}/${onLoad.table}）`);
  ok(/认出 30 条/.test(onLoad.sum) && /自动补 0x36\/0x3A/.test(onLoad.sum), `摘要说清了结果（含"已自动补前缀"）：「${onLoad.sum.slice(0, 72)}」`);

  // 切到 ST77916 示例（192 条 / 215 参数字节 / 120 ms）
  const st = await ev(`
    document.getElementById('pn-code-preset').value = 'st77916';
    document.getElementById('pn-code-load').click();
    await new Promise(r => setTimeout(r, 400));
    return { sum: document.getElementById('pn-code-sum').textContent,
             rows: window.__tools.panel.summary().rows,
             table: document.querySelectorAll('#pn-code-body tr').length };`);
  ok(st.rows === 192 && st.table === 194, `ST77916 示例解析出 192 条（+2 前缀 = 194 行，实测 ${st.rows}/${st.table}）`);
  ok(/215 参数字节/.test(st.sum) && /累计延时 120 ms/.test(st.sum), `统计与源文件声明一致：「${st.sum.replace(/ · 格式 \w+/, '')}」`);

  // 自己贴一段：C 数组（含一行故意写坏的）
  const pasted = await ev(`
    document.getElementById('pn-code-text').value =
      '/* 我自己贴的 */\\n' +
      'static const x y[] = {\\n' +
      '  {0xCE, (uint8_t[]){0x5A, 0xA5}, 2, 0},\\n' +
      '  {0x11, NULL, 0, 100},\\n' +
      '  {0xZZ, NULL, 0, 0},\\n' +
      '};\\n';
    document.getElementById('pn-code-parse').click();
    await new Promise(r => setTimeout(r, 300));
    return { sum: document.getElementById('pn-code-sum').textContent,
             rows: window.__tools.panel.summary().rows,
             errs: window.__tools.panel.summary().parseErrors,
             log: document.getElementById('pn-log').textContent };`);
  ok(pasted.rows === 2, `贴进去的 C 数组解析出 2 条（坏的那行不算：${pasted.rows}）`);
  ok(pasted.errs >= 1 && /没认出来/.test(pasted.log), `写坏的那行被点出来（${pasted.errs} 条错误，日志里有「第 N 行没认出来」）`);

  // 导出的 C 片段能被自己再解析回来（往返）
  const round = await ev(`
    const P = await import('/app/spi/panel-code.js');
    const rows = window.__tools.panel.rows;
    const c = P.rowsToC(rows);
    const back = P.parsePanelCode(c);
    return { text: c.slice(0, 48), n: back.rows.length, first: back.rows[0]?.cmd };`);
  ok(round.n === 2 && round.first === 0xce, `导出的 C 片段能再解析回来（${round.n} 条）`);
}

// ==================================================================== 5b
console.log('== 5b. 字节编辑（照 bmp_sender.html）：每格一个字节可直接敲 + 点开位开关板 ==');
{
  const opened = await ev(`
    // 用内置 AXS15352 示例（第 0 行是自动补的 MADCTL 0x36 = 0x00，正是要试色序的那个字节）
    document.getElementById('pn-code-preset').value = 'axs15352';
    document.getElementById('pn-code-load').click();
    await new Promise(r => setTimeout(r, 300));
    const cell = document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx');
    cell.click();
    await new Promise(r => setTimeout(r, 80));
    const pop = document.getElementById('pn-bitpop');
    const bits = [...pop.querySelectorAll('#pn-bitpop-bits button.bit')];
    return { hidden: pop.hidden, bits: bits.length,
             onBits: bits.filter(b => b.classList.contains('on')).length,
             chgBits: bits.filter(b => b.classList.contains('chg')).length,
             firstBit: bits[0]?.textContent.replace(/\\s+/g, ' ').trim(),
             title: document.getElementById('pn-bitpop-title').textContent,
             val: document.getElementById('pn-bitpop-val').textContent,
             hint: document.getElementById('pn-bitpop-hint').textContent,
             acts: [...pop.querySelectorAll('button[data-bit]')].map(b => b.dataset.bit),
             ruler: document.getElementById('pn-code-ruler').textContent.trim(),
             cellCount: document.querySelectorAll('#pn-code-body tr:nth-child(1) td.params input.bx').length,
             text: document.getElementById('pn-code-text').value };`);
  ok(opened.hidden === false && opened.bits === 8, `点参数字节弹出 8 个 bit 方块（bit 数 ${opened.bits}）`);
  ok(opened.onBits === 0 && opened.chgBits === 0 && /0x00 = 0 = 0b00000000/.test(opened.val),
     `当前值 0x00 一位都没亮（「${opened.val}」）`);
  ok(/bit7/.test(opened.firstBit) && /128/.test(opened.firstBit), `方块是"bit号 + 0/1 + 权重"三行：${opened.firstBit}`);
  ok(/第 0 条（0x36）· 第 0 字节/.test(opened.title), `标题带行号与字节号：「${opened.title}」`);
  ok(/MADCTL/.test(opened.hint) && /BGR/.test(opened.hint), `已知命令给位名（MADCTL/BGR）：${opened.hint.slice(0, 40)}…`);
  ok(opened.acts.join(',') === 'zero,ones,inv,orig,close', `一排快捷键齐了（${opened.acts.join('/')}）`);
  ok(/^0 1 2 3/.test(opened.ruler), `表头有字节序号标尺：「${opened.ruler.slice(0, 24)}…」`);
  ok(opened.cellCount >= 1, `参数字节每格一个输入框（第 0 行 ${opened.cellCount} 格）`);

  const toggled = await ev(`
    const pop = document.getElementById('pn-bitpop');
    pop.querySelector('#pn-bitpop-bits button.bit[data-k="3"]').click();      // bit3 = MADCTL 的 BGR 位
    await new Promise(r => setTimeout(r, 80));
    const cell = document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx');
    const row = window.__tools.panel.effectiveRows[0];
    return { val: document.getElementById('pn-bitpop-val').textContent,
             onBits: [...pop.querySelectorAll('#pn-bitpop-bits button.bit')].filter(b => b.classList.contains('on')).length,
             chgBits: [...pop.querySelectorAll('#pn-bitpop-bits button.bit')].filter(b => b.classList.contains('chg')).length,
             cell: cell.value, dirty: document.querySelectorAll('#pn-code-body tr.dirty').length,
             data: Array.from(row.data),
             sum: document.getElementById('pn-code-sum').textContent,
             text: document.getElementById('pn-code-text').value };`);
  ok(/0x08 = 8 = 0b00001000/.test(toggled.val) && /原 0x00/.test(toggled.val), `勾 bit3 → 0x08 并标出原值（${toggled.val}）`);
  ok(toggled.onBits === 1 && toggled.chgBits === 1, '只有 bit3 亮，且它被标成"和原值不同"（黄框）');
  ok(toggled.data[0] === 0x08 && toggled.cell === '08', `表格格子与行数据同步（cell=${toggled.cell} data=${toggled.data}）`);
  ok(toggled.dirty === 1 && /已改 1 行/.test(toggled.sum), `行变脏 + 摘要说明「${toggled.sum.slice(0, 60)}…」`);
  ok(toggled.text === opened.text && opened.text.length > 500,
     `上面的文本框一个字符都没动（${opened.text.length} 字符逐字节相同 —— 原文是用户的资产）`);

  const typed = await ev(`
    // 表格里**直接敲十六进制**（与点 bit 走同一条路） + 一键快捷键 + 「改回」
    const cell = document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx');
    cell.value = '5a'; cell.dispatchEvent(new Event('change', { bubbles: true }));   // 真浏览器里 change 会冒泡
    await new Promise(r => setTimeout(r, 60));
    const afterType = { data: Array.from(window.__tools.panel.effectiveRows[0].data), val: document.getElementById('pn-bitpop-val').textContent };
    document.getElementById('pn-bitpop').querySelector('button[data-bit="inv"]').click();      // 逐位取反
    await new Promise(r => setTimeout(r, 60));
    const afterInv = Array.from(window.__tools.panel.effectiveRows[0].data);
    document.getElementById('pn-bitpop').querySelector('button[data-bit="orig"]').click();     // 恢复原值
    await new Promise(r => setTimeout(r, 60));
    const afterOrig = { data: Array.from(window.__tools.panel.effectiveRows[0].data),
                        dirty: document.querySelectorAll('#pn-code-body tr.dirty').length,
                        sum: document.getElementById('pn-code-sum').textContent };
    // 再改一次，然后点行尾「改回」
    document.getElementById('pn-bitpop').querySelector('button[data-bit="ones"]').click();
    await new Promise(r => setTimeout(r, 60));
    const dirtyBefore = document.querySelectorAll('#pn-code-body tr.dirty').length;
    document.querySelector('#pn-code-body button[data-act="revert"]').click();
    await new Promise(r => setTimeout(r, 80));
    const afterRevert = { data: Array.from(window.__tools.panel.effectiveRows[0].data),
                          dirty: document.querySelectorAll('#pn-code-body tr.dirty').length,
                          cell: document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx').value,
                          sum: document.getElementById('pn-code-sum').textContent };
    document.getElementById('pn-bitpop').querySelector('button[data-bit="close"]').click();
    await new Promise(r => setTimeout(r, 60));
    return { afterType, afterInv, afterOrig, dirtyBefore, afterRevert, hidden: document.getElementById('pn-bitpop').hidden };`);
  ok(typed.afterType.data[0] === 0x5a && /0x5A/.test(typed.afterType.val), '直接在格子里敲十六进制就改了字节（位开关板同步）');
  ok(typed.afterInv[0] === 0xa5, `逐位取反 = 0xA5（0x${typed.afterInv[0].toString(16)}）`);
  ok(typed.afterOrig.data[0] === 0x00 && typed.afterOrig.dirty === 0 && !/已改/.test(typed.afterOrig.sum),
     '「恢复原值」把这一字节改回 0x00，行也自己变干净了（脏标记是跟原值比对，不是粘住的 flag）');
  ok(typed.dirtyBefore === 1 && typed.afterRevert.data[0] === 0x00 && typed.afterRevert.dirty === 0 &&
     typed.afterRevert.cell === '00', `行尾「改回」还原整行（格子回到 ${typed.afterRevert.cell}）`);
  ok(typed.hidden === true, '「完成」把位开关板收起来');

  // 改过的值必须进到"重放"要发的那一串 STEP 里（用假探针看线上字节：档 1 = 命令 + 参数）
  const replay = await ev(`
    document.getElementById('pn-preset').value = 'axs15352';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    document.getElementById('pn-enable').click();
    await new Promise(r => setTimeout(r, 400));
    const s = window.__tools.spiSession, p = s.mockProbe;
    const cell = document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx');
    cell.click();
    await new Promise(r => setTimeout(r, 60));
    document.getElementById('pn-bitpop-bits').querySelector('button.bit[data-k="3"]').click();   // MADCTL → 0x08
    await new Promise(r => setTimeout(r, 60));
    document.getElementById('pn-bitpop').querySelector('button[data-bit="close"]').click();
    p.resetState();
    document.getElementById('pn-code-play').click();
    for (let i = 0; i < 200 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    const hex = w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ');
    return { wire: p.wire.slice(0, 2).map(hex), ok: p.stats.framesOk, err: p.stats.framesErr,
             log: document.getElementById('pn-log').textContent };`);
  ok(replay.wire[0] === '36 08', `改过的 MADCTL 真的按 0x08 发出去（档 1 线上字节「${replay.wire[0]}」，原文是 36 00）`);
  ok(replay.err === 0 && replay.ok >= 32, `整表照样跑完（frames_ok=${replay.ok} err=${replay.err}）`);
  ok(/改成 0x08/.test(replay.log), '日志里留了"哪一行改成什么"的记录（可追溯）');

  // 复位：重新「解析并预览」把改动丢掉（按原文重建）——这是有意的，得让用户看得见
  const reset = await ev(`
    document.getElementById('pn-code-parse').click();
    await new Promise(r => setTimeout(r, 200));
    return { data: Array.from(window.__tools.panel.effectiveRows[0].data),
             edited: window.__tools.panel.summary().editedRows,
             sum: document.getElementById('pn-code-sum').textContent };`);
  ok(reset.data[0] === 0x00 && reset.edited === 0 && !/已改/.test(reset.sum),
     '重新解析 → 改动清空、回到原文（步骤表按贴进来的文本重建）');
}

// ==================================================================== 6
console.log('== 6. 重放：整表下发 + 单发（假探针逐帧对账）==');
{
  const replay = await ev(`
    // 先把"屏"定死：ST77916 = 档 2 + 360×360 + 40 MHz（否则下面每条的展开形态都不确定）
    document.getElementById('pn-preset').value = 'st77916';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 1000));
    document.getElementById('pn-enable').click();
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('pn-code-preset').value = 'st77916';
    document.getElementById('pn-code-load').click();
    await new Promise(r => setTimeout(r, 400));
    const s = window.__tools.spiSession, p = s.mockProbe;
    p.resetState();
    const t0 = performance.now();
    document.getElementById('pn-code-play').click();
    for (let i = 0; i < 200 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    return { wireLog: p.wireLog.slice(0, 3),
             enabled: s.enabled, profile: s.profile?.profile, geom: document.getElementById('pn-geom').value,
             framesOk: p.stats.framesOk, framesErr: p.stats.framesErr,
             bytesTx: p.stats.bytesTx, ms: performance.now() - t0,
             prog: document.getElementById('pn-code-prog').textContent,
             log: document.getElementById('pn-log').textContent };`);
  ok(replay.wireLog[0] === 'RESET low=10ms post=120ms' && replay.wireLog[1] === 'GPIO bl=1',
     `重放第一批就是"复位 → 开背光"（实测「${replay.wireLog.slice(0, 2).join(' | ')}」）`);
  ok(replay.enabled === true, '桥已使能（未使能时帧只会被 NAK）');
  ok(replay.profile === 2 && replay.geom === 'st77916', `已套用 ST77916：档 2 + 几何 st77916（实测 档${replay.profile} / ${replay.geom}）`);
  ok(replay.framesOk === 196 && replay.framesErr === 0, `重放前置 2 帧（RST + 背光）+ 192 条 + 2 条自动前缀 = 196 帧全成功（frames_ok=${replay.framesOk} err=${replay.framesErr}）`);
  ok(replay.bytesTx >= 215, `线上字节 ≥ 参数字节 215（实测 ${replay.bytesTx}，含每条 4 B STEP 头与档 2 的 4 B 前缀）`);
  ok(/完成/.test(replay.prog), `进度行收尾：「${replay.prog}」`);

  // 单发第 3 行（表格含 2 条自动前缀，故 index 3 = 厂家表第 2 条 {0xF2, {0x28}, 1, 0}）：只有一帧
  const one = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    p.resetState();
    document.querySelector('#pn-code-body button[data-act="one"][data-i="3"]').click();
    for (let i = 0; i < 60 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 200));
    return { framesOk: p.stats.framesOk, wire: p.wire.map(w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ')) };`);
  ok(one.framesOk === 3 && one.wire.length === 1, `「单发」= 前置 2 帧 + 目标那 1 帧（${one.framesOk} 帧，其中数据帧 ${one.wire.length} 条）`);
  ok(one.wire[0] === '02 f2 00 00 28', `档 2 展开正确：0x02 + 命令字 0xF2 + 24bit 地址(0) + 参数 0x28（实测 ${one.wire[0]}）`);

  // 前两行必须是自动补的 0x36/0x3A（AXS15352 缺了会全黑）
  // ⚠️ 值现在在输入框里（不参与 textContent），所以读 input.value 而不是行文本
  const prefix = await ev(`
    const rows = [...document.querySelectorAll('#pn-code-body tr')].slice(0, 2);
    return rows.map(tr => ({ cmd: tr.querySelector('input.bx.cmd').value,
                             p0: tr.querySelector('td.params input.bx')?.value || '',
                             txt: tr.textContent.replace(/\\s+/g, ' ').trim() }));`);
  ok(prefix[0].cmd === '36' && prefix[0].p0 === '00' && /MADCTL/.test(prefix[0].txt) &&
     prefix[1].cmd === '3a' && prefix[1].p0 === '55' && /COLMOD/.test(prefix[1].txt),
     `表格最前面两行是自动补的 MADCTL/COLMOD：「0x${prefix[0].cmd} 0x${prefix[0].p0} ${prefix[0].txt.slice(0, 22)}」/「0x${prefix[1].cmd} 0x${prefix[1].p0}」`);

  /**
   * 重放前的「复位 + 开背光」（默认勾上）：
   * ① 勾着 → 每条重放路径（整表 / 单发 / 从此重放）都先发 RST 脉冲 + 背光开，且**排在最前面**；
   * ② 取消勾选 → 之前的行为一字不差地回来（只有数据帧，不多打扰屏）。
   * 复用同一个「单发」按钮 = 三条路径共用 `playRows`，验一条就够。
   */
  const pre = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    const fire = async () => {
      p.resetState();
      document.querySelector('#pn-code-body button[data-act="one"][data-i="3"]').click();
      for (let i = 0; i < 60 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
      await new Promise(r => setTimeout(r, 250));
      return { ok: p.stats.framesOk, err: p.stats.framesErr, types: p.wire.map(w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ')),
               actions: p.wireLog.filter(x => /RESET|GPIO|STEP/.test(x)), delays: p.delays };
    };
    const chk = document.getElementById('pn-replay-prereset');
    const defaultOn = chk.checked;
    const on = await fire();
    chk.checked = false;
    const off = await fire();
    chk.checked = true;
    return { defaultOn, on, off };`);
  ok(pre.defaultOn === true, '「重放前先复位 + 开背光」默认就是勾上的');
  ok(pre.on.actions.slice(0, 2).join(' | ') === 'RESET low=10ms post=120ms | GPIO bl=1' &&
     pre.on.actions[2]?.startsWith('STEP cmd=0xf2'),
     `勾着：复位 → 开背光 → 再发数据，顺序对（实测「${pre.on.actions.join(' | ')}」）`);
  ok(pre.on.delays.includes(130) && pre.on.err === 0,
     `复位时序沿用那一行的 10 / 120（登记 ${pre.on.delays.join(',')}）`);
  ok(pre.off.actions.length === 1 && pre.off.actions[0].startsWith('STEP cmd=0xf2') && pre.off.err === 0,
     `取消勾选 → 只发数据那条，不碰 RST/BL（实测「${pre.off.actions.join(' | ')}」）`);
  ok(pre.off.ok === 1 && pre.on.ok === 3, `取消勾选后帧数从 ${pre.on.ok} 回到 ${pre.off.ok}（前置 2 帧真的没了）`);
}

// ==================================================================== 7
console.log('== 7. 图片 / 图案刷屏 ==');
{
  const pat = await ev(`
    const btns = [...document.querySelectorAll('#pn-patterns button')];
    btns.find(b => b.textContent === '色条 8').click();
    await new Promise(r => setTimeout(r, 300));
    const cv = document.getElementById('pn-canvas');
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let nonBlack = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) nonBlack++;
    return { w: cv.width, h: cv.height, nonBlack, sum: document.getElementById('pn-img-sum').textContent,
             src: window.__tools.panel.summary().source };`);
  ok(pat.nonBlack > pat.w * pat.h * 0.5, `图案画到预览上了（${pat.nonBlack} 个非黑像素 / ${pat.w * pat.h}）`);
  ok(/527 片/.test(pat.sum), `预览信息给出切片数：「${pat.sum.split('\n')[1] || pat.sum}」`);

  // 开窗对齐：x=3 → 窗口被扩到 4 的倍数
  const align = await ev(`
    document.getElementById('pn-x').value = '3';
    document.getElementById('pn-x').dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    return document.getElementById('pn-img-sum').textContent;`);
  ok(/窗口 0\.\./.test(align) && /对齐补/.test(align), `x=3 被对齐到 0（列 4 对齐提示可见）：「${align.split('\n')[0]}」`);
  await ev(`document.getElementById('pn-x').value = '0'; document.getElementById('pn-x').dispatchEvent(new Event('input')); return true;`);

  // 刷一张 ST77916 整屏（360×360 = 259200 B → 527 片）
  const send = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    p.resetState();
    const before = p.stats.bytesTx;
    document.getElementById('pn-img-send').click();
    for (let i = 0; i < 300 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 400));
    return { framesOk: p.stats.framesOk, framesErr: p.stats.framesErr,
             bytesTx: p.stats.bytesTx - before, geom: document.getElementById('pn-geom').value,
             log: document.getElementById('pn-log').textContent };`);
  ok(send.geom === 'st77916', '屏幕几何跟着"套用推荐值"切到了 ST77916');
  // 刷图**不**走重放前置（见 §8 那条），所以这里是 2 条开窗 + 527 片像素，没有 RST/BL
  ok(send.framesOk === 529 && send.framesErr === 0, `整屏 529 帧全成功（2 条开窗 + 527 片像素，实测 ${send.framesOk}）`);
  // 开窗在档 2 是两条 XFER（opcode + 00 XX 00 + 4 字节坐标），所以是 2×4 而不是老写法两条 STEP 的 16
  ok(send.bytesTx === 259200 + 8, `线上字节 = 像素 259200 + 开窗 8（QSPI 两条 XFER 各 4 字节坐标，实测 ${send.bytesTx}）`);
  ok(/刷图完成：527 片/.test(send.log), `日志里给了切片数与速率（「${(send.log.match(/刷图完成[^\n]*/) || [''])[0]}」）`);

  // R/B 交换：同一张图，勾上之后首片像素字节不同（抽验第一片的前 2 字节）
  const swap = await ev(`
    const I = await import('/app/spi/image.js');
    const g = I.PANEL_GEOMETRY.st77916;
    const im = I.makePattern('R', g.w, g.h);
    const a = I.rgbaTo565(im.rgba.subarray(0, 4), { swap: false });
    const b = I.rgbaTo565(im.rgba.subarray(0, 4), { swap: true });
    return { a: [...a], b: [...b] };`);
  ok(swap.a.join(',') === '248,0' && swap.b.join(',') === '0,31',
     `R/B 交换真的换了个字节序（不勾 ${swap.a.join('/')} → 勾上 ${swap.b.join('/')}）`);
}

// ==================================================================== 8
console.log('== 8. 面板电源 / 显示 4 个命令 + RST 脉冲 ==');
{
  const disp = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    p.wire = []; p.delays = [];
    for (const id of ['pn-pwr-on', 'pn-disp-on', 'pn-disp-off', 'pn-pwr-off']){
      document.getElementById(id).click();
      await new Promise(r => setTimeout(r, 260));
    }
    return { wire: p.wire.map(w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ')), delays: p.delays };`);
  ok(disp.wire.length === 4, `4 个按钮各发一条 STEP（实测 ${disp.wire.length} 条：${disp.wire.join(' | ')}）`);
  ok(disp.wire[0]?.startsWith('02 11 00 00') && disp.wire[1]?.startsWith('02 29 00 00') &&
     disp.wire[2]?.startsWith('02 28 00 00') && disp.wire[3]?.startsWith('02 10 00 00'),
     `顺序与命令字对：上电 11h → 开显示 29h → 关显示 28h → 下电 10h`);
  ok(disp.delays.filter(d => d === 120).length === 2, `上电/下电各带 120 ms 等待（实测 ${disp.delays.join(',')}）`);

  const rst = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    p.delays = [];
    document.getElementById('pn-rst-low').value = '10';
    document.getElementById('pn-rst-post').value = '120';
    document.getElementById('pn-rst-send').click();
    await new Promise(r => setTimeout(r, 500));
    return { delays: p.delays, log: document.getElementById('pn-log').textContent };`);
  ok(rst.delays.includes(130), `RST 脉冲 = 拉低 10 ms + 释放后等 120 ms（登记 ${rst.delays.join(',')}）`);

  /**
   * 「复位并开背光」一键按钮：= RST 脉冲 + 开背光两条，顺序不能反
   * （背光必须在复位时序走完、屏内部初始化稳下来之后才点亮）。
   */
  const both = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    p.resetState();
    document.getElementById('pn-rst-low').value = '12';
    document.getElementById('pn-rst-post').value = '130';
    document.getElementById('pn-rst-bl').click();
    await new Promise(r => setTimeout(r, 900));
    return { ok: p.stats.framesOk, err: p.stats.framesErr, delays: p.delays, pins: p.pins,
             log: p.wireLog.filter(x => /RESET|GPIO/.test(x)),
             pageLog: document.getElementById('pn-log').textContent };`);
  ok(both.ok === 2 && both.err === 0, `一键 = 2 帧（RST + 背光开），实测 ${both.ok} 帧 / ${both.err} 错`);
  ok(both.log.join(' | ') === 'RESET low=12ms post=130ms | GPIO bl=1',
     `先复位后开背光，顺序与参数都对（实测「${both.log.join(' | ')}」）`);
  ok(both.delays.includes(142), `延时按填的数字登记 12+130=142 ms（登记 ${both.delays.join(',')}）`);
  // ST77916 档里 padActiveLow=0x06 = bit1(RST) + bit2(CS) 低有效，**BL 不在内**（bit3）
  // → 开背光（逻辑 1）就是物理高；复位结束后 RST 也回到无效=高
  ok(both.pins.bl === 1 && both.pins.rst === 1,
     `物理电平按电平表来：BL 不在低有效位图里 → 开背光=高（pins.bl=${both.pins.bl} rst=${both.pins.rst}）`);

  /**
   * 没配 RST 脚（协议里 **0 = （不用）**，见 protocol.PADS[0]）时必须**跳过复位但照常开背光**，
   * 并在日志里说清原因 —— 这条挡的是"重放前悄悄什么都没做、用户以为复位过了"这种最坑的静默失败。
   *
   * 🚨 `applyConfig` 里是一串 HID 往返（4 条 PIN_CFG + SET_CFG + 回读），必须 **await + 等回读到**，
   *    否则下面读到的还是旧 padRst，"跳过"分支根本不会走（本文件踩过：只 sleep 300 ms 不够）。
   */
  const noRst = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    const c0 = { ...s.cfg };
    const rst0 = c0.padRst;                             // 不写死 13/5：跟着当前推荐值走
    await s.applyConfig({ ...c0, padRst: 0 }, 'panel');
    const applied = s.cfg.padRst;                       // 回读对账：真变成 0 了才继续
    p.resetState();
    document.getElementById('pn-log').innerHTML = '';
    const sent = await window.__tools.panel.resetAndBacklight();
    await new Promise(r => setTimeout(r, 400));
    const log = p.wireLog.filter(x => /RESET|GPIO/.test(x));
    const pageLog = document.getElementById('pn-log').textContent;
    await s.applyConfig(c0, 'panel');
    return { sent, log, pageLog, applied, rst0, rstBack: s.cfg.padRst };`);
  ok(noRst.applied === 0, `（前置条件）padRst 确实写进了 0 =「不用」（实测 ${noRst.applied}）`);
  ok(noRst.sent === true && noRst.log.join(' | ') === 'GPIO bl=1',
     `RST 脚没配 → 跳过复位、背光照开（实测「${noRst.log.join(' | ')}」）`);
  ok(/跳过复位/.test(noRst.pageLog) && /pad 0/.test(noRst.pageLog),
     `日志明确告警"跳过复位"并给出原因（「${(noRst.pageLog.match(/[^\n]*跳过复位[^\n]*/) || [''])[0]}」）`);
  ok(noRst.rstBack === noRst.rst0, `测完把 padRst 还原成 ${noRst.rstBack}（不脏化后续用例）`);

  /**
   * 「刷这一张」**不**走重放前置（用户 2026-09-30 只点名了重放）：刷屏是高频动作，
   * 每刷一次就复位会闪。要复位就走上面那个一键按钮 —— 这条把"范围"钉死，防止以后被顺手扩大。
   */
  const blOffset = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    p.resetState();
    document.getElementById('pn-img-send').click();
    for (let i = 0; i < 300 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 400));
    return { host: p.wireLog.filter(x => /RESET|GPIO/.test(x)).length, ok: p.stats.framesOk };`);
  ok(blOffset.host === 0, `刷图路径不发 RST/BL（实测 ${blOffset.host} 条 —— 前置只管重放那三条路）`);
}

// ==================================================================== 9
console.log('== 9. 两页联动：屏页失能 → 桥页立刻看到 ==');
{
  const off = await ev(`
    document.getElementById('pn-disable').click();
    await new Promise(r => setTimeout(r, 500));
    await window.__tools.spiSession.pollStatus(true);
    return { enabled: window.__tools.spiSession.enabled,
             busWord: document.getElementById('sp-word-text').textContent,
             pnEnableDisabled: document.getElementById('pn-enable').disabled };`);
  ok(off.enabled === false, '屏页点「失能」→ 会话状态里 enabled=false');
  ok(off.pnEnableDisabled === false, '屏页按钮状态正常（连接还在）');

  // 切回桥页：日志是按 ring 重建的（在屏页期间的操作不会丢）
  await ev(`document.querySelector('#tabs .tab[data-tab="spi"]').click(); return true;`);
  await sleep(400);
  const busLog = await ev(`return document.getElementById('sp-log').textContent;`);
  ok(/\[屏\]/.test(busLog), '桥页日志里能看到屏页发起的操作（带 [屏] 前缀）');
  ok(/STEP/.test(busLog), '屏页发的 STEP 也补进了桥页日志（切页按 ring 重放）');
}

// ==================================================================== 9b
console.log('== 9b. 动画 / 视频：录一段 WebM 当源 → 逐帧整屏刷（假探针对账）==');
{
  // ① 源：页面里现录一段（canvas.captureStream + MediaRecorder），不依赖任何外部素材
  //    🚨 用 `captureStream(0)` + `track.requestFrame()` 手动推帧：自动帧率那条路在
  //    "画布不在 DOM 里 / 窗口被遮住"时会一帧都录不到（实测只录出 110 字节的裸头）。
  //    🚨 而且**录出来"有字节"不等于"能播"**：偶发（机器忙时）会录出一个浏览器解不开的 blob，
  //    下游就变成"加载失败：读视频元数据超时"—— 2026-09-30 全量自测扫的时候撞到过（7 条连带失败），
  //    单跑又全绿。所以这里当场用 `<video>` 自检一遍，不能播就**重录**（最多 3 次），
  //    别让"素材没录好"伪装成"页面坏了"。
  let rec = null;
  for (let attempt = 1; attempt <= 3; attempt++){
    rec = await ev(`
      const cv = document.createElement('canvas'); cv.width = 96; cv.height = 120;
      cv.style.cssText = 'position:fixed;right:6px;bottom:6px;width:96px;height:120px;z-index:9';
      document.body.appendChild(cv);
      const ctx = cv.getContext('2d');
      const stream = cv.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise(r => { rec.onstop = r; });
      rec.start();
      for (let i = 0; i < 10; i++){
        ctx.fillStyle = i % 2 ? '#ff0000' : '#0000ff';
        ctx.fillRect(0, 0, 96, 120);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(i * 8, 40, 16, 16);
        track.requestFrame();
        await new Promise(r => setTimeout(r, 80));
      }
      rec.stop();
      await stopped;
      track.stop();
      cv.remove();
      const blob = new Blob(chunks, { type: 'video/webm' });
      window.__animFile = new File([blob], 'selftest.webm', { type: 'video/webm' });
      // 自检：这个 blob 到底能不能被 <video> 解析出元数据？
      const probe = document.createElement('video');
      probe.muted = true; probe.playsInline = true;
      probe.src = URL.createObjectURL(blob);
      const playable = await new Promise(res => {
        const t = setTimeout(() => res(false), 5000);
        probe.addEventListener('loadedmetadata', () => { clearTimeout(t); res(probe.videoWidth > 0); });
        probe.addEventListener('error', () => { clearTimeout(t); res(false); });
      });
      probe.removeAttribute('src');
      return { bytes: blob.size, chunks: chunks.length, playable };`);
    if (rec.playable && rec.bytes > 500) break;
    console.log(`  ↻ 录出来的 WebM 不能被浏览器解析（${rec.bytes} 字节 / playable=${rec.playable}），重录第 ${attempt} 次`);
  }
  ok(rec.bytes > 500 && rec.playable === true,
     `页面里现录了一段 WebM 当测试素材（${rec.bytes} 字节 / ${rec.chunks} 块 / 元数据可读=${rec.playable}）`);

  const loaded = await ev(`
    const input = document.getElementById('pn-anim-input');
    const dt = new DataTransfer(); dt.items.add(window.__animFile);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40 && !window.__tools.panel.summary().anim.src; i++) await new Promise(r => setTimeout(r, 100));
    const s = window.__tools.panel.summary();
    return { anim: s.anim, videoOn: document.getElementById('pn-anim-video').classList.contains('on'),
             playDisabled: document.getElementById('pn-anim-play').disabled,
             info: document.getElementById('pn-anim-info').textContent.slice(0, 80) };`);
  ok(loaded.anim?.src && /selftest\.webm/.test(loaded.anim.src) && loaded.anim.src.includes('video'),
     `源已装载：${loaded.anim?.src}`);
  ok(loaded.videoOn === true && loaded.playDisabled === false, '源片段预览出现、「播放到屏」可用');

  // ② 播放：先定死 AXS15352（档 1）+ 使能，再开播 ~2 s
  const played = await ev(`
    document.getElementById('pn-preset').value = 'axs15352';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    await window.__tools.spiSession.setEnabled(true, 'bus');
    await new Promise(r => setTimeout(r, 300));
    const p = window.__tools.spiSession.mockProbe;
    p.resetState();
    document.getElementById('pn-anim-play').click();
    await new Promise(r => setTimeout(r, 2200));
    const during = window.__tools.panel.summary().anim;
    const stopDisabled = document.getElementById('pn-anim-stop').disabled;
    document.getElementById('pn-anim-stop').click();
    await new Promise(r => setTimeout(r, 800));
    const after = window.__tools.panel.summary().anim;
    return { during, after, stopDisabled,
             framesOk: p.stats.framesOk, framesErr: p.stats.framesErr, bytesTx: p.stats.bytesTx,
             info: document.getElementById('pn-anim-info').textContent,
             log: document.getElementById('pn-log').textContent };`);
  ok(played.during.running === true && played.stopDisabled === false, '播放中：停止按钮可用');
  ok(played.after.frames >= 3, `2.2 s 内发了 ${played.after.frames} 帧（整帧 292 帧/次）`);
  ok(played.after.frames * 292 <= played.framesOk, `假探针执行帧数对账：${played.framesOk} ≥ ${played.after.frames}×292`);
  ok(played.framesErr === 0, `零错误（frames_err=${played.framesErr}）`);
  ok(played.after.bytes >= played.after.frames * 142080 * 0.99,
     `字节对账：${(played.after.bytes / 1024).toFixed(0)} KB ≈ ${played.after.frames} 帧 × 142080 B`);
  ok(played.after.fps > 0 && played.after.kbs > 0 && played.after.fps < 60, `实测速率合理：${played.after.fps} fps / ${played.after.kbs} KB/s`);
  ok(played.after.running === false && /停止|上次/.test(played.info) && !/NaN/.test(played.info),
     `停止后状态行给了总结：「${played.info.slice(0, 70)}」`);
  ok(/动画开始/.test(played.log) && /动画结束/.test(played.log), '日志里有开始/结束（含实测 fps）');
  ok(played.after.dropped >= 0, `丢帧计数存在（${played.after.dropped}）—— 发送是节拍器，解码更快就丢`);

  // ③ GIF/PNG 那条路（ImageDecoder）：拿刚画的 canvas 存一张 PNG 当"单帧动画"
  const img = await ev(`
    const cv = document.createElement('canvas'); cv.width = 240; cv.height = 296;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, 240, 296);
    ctx.fillStyle = '#f0f'; ctx.fillRect(20, 20, 60, 60);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const input = document.getElementById('pn-anim-input');
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'frame.png', { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 30 && !/png/.test(window.__tools.panel.summary().anim?.src || ''); i++) await new Promise(r => setTimeout(r, 100));
    const p = window.__tools.spiSession.mockProbe;
    p.resetState();
    document.getElementById('pn-anim-play').click();
    await new Promise(r => setTimeout(r, 1000));
    document.getElementById('pn-anim-stop').click();
    await new Promise(r => setTimeout(r, 600));
    return { anim: window.__tools.panel.summary().anim, framesErr: p.stats.framesErr };`);
  ok(/frame\.png/.test(img.anim?.src || '') && img.anim.frames >= 2,
     `ImageDecoder 那条路也通（PNG 单帧循环发了 ${img.anim?.frames} 帧，零错误=${img.framesErr === 0}）`);
}

// ==================================================================== 9c
console.log('== 9c. 仓库自带素材（samples/anim）：帧数认得出来 · 不勾循环播完就停 ==');
{
  // 🚨 这一条钉的是两个真出现过的坑（2026-10 实测 Chrome 153）：
  //    ① `await decoder.completed` 之后 `tracks.selectedTrack` 还是 null → frameCount 记成 0，
  //       状态行写成"0 帧"，用户以为素材坏了；
  //    ② 帧数 0 时 `_runGif` 里 `i >= 0` 第一帧就成立 → **不勾循环时只播一帧**。
  //    素材由 tools/dev/make-anim-samples.py 生成，静态服务 8899 的根目录就是仓库根 —— 同源 fetch 得到。
  const gif = await ev(`
    const r = await fetch('samples/anim/bars-sweep-240x296.gif').catch(() => null);
    if (!r || !r.ok) return { skip: r ? 'HTTP ' + r.status : '取不到' };
    const b = await r.blob();
    const input = document.getElementById('pn-anim-input');
    const dt = new DataTransfer(); dt.items.add(new File([b], 'bars-sweep-240x296.gif', { type: 'image/gif' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 60 && !/bars-sweep/.test(window.__tools.panel.summary().anim?.src || ''); i++) await new Promise(r => setTimeout(r, 100));
    return { bytes: b.size, anim: window.__tools.panel.summary().anim,
             info: document.getElementById('pn-anim-info').textContent };`);
  if (gif.skip){
    console.log(`  ⚠ 跳过：本地静态服务里没有 samples/anim（${gif.skip}）—— 先跑 make samples-anim`);
  } else {
    ok(gif.anim?.srcFrames === 50, `GIF 帧数认得出来：srcFrames=${gif.anim?.srcFrames}（素材 50 帧 / ${gif.bytes} B）`);
    ok(/50 帧/.test(gif.info), `状态行如实写帧数：「${gif.info.slice(0, 64)}」`);
    const once = await ev(`
      const loop = document.getElementById('pn-anim-loop');
      loop.checked = false; loop.dispatchEvent(new Event('change', { bubbles: true }));
      const p = window.__tools.spiSession.mockProbe; p.resetState();
      document.getElementById('pn-anim-play').click();
      for (let i = 0; i < 120; i++){ await new Promise(r => setTimeout(r, 100)); if (!window.__tools.panel.summary().anim.running) break; }
      const a = window.__tools.panel.summary().anim;
      loop.checked = true; loop.dispatchEvent(new Event('change', { bubbles: true }));
      return { a, framesErr: p.stats.framesErr, info: document.getElementById('pn-anim-info').textContent };`);
    ok(once.a.running === false && once.a.frames >= 40,
       `不勾循环：播完自己停，共 ${once.a.frames} 帧（曾经只播 1 帧）`);
    ok(once.framesErr === 0, `零错误（frames_err=${once.framesErr}）`);
    ok(!/NaN/.test(once.info), `停止后状态行没有 NaN：「${once.info.slice(0, 64)}」`);
  }
}

// ==================================================================== 9d
console.log('== 9d. 攒批：USB 调用次数降一个数量级，设备侧收到的帧一个不少 ==');
{
  // 背景（2026-10，用户现场 "3 MB/s 瓶颈在哪"）：一帧 240×296 = 142 KB 被"一帧不跨包"切成
  // 289 片像素 + 3 条命令 = 292 个帧。固件每次只 arm 一个 512 B 槽，但 **USB 层面一次 bulk 传输
  // 可以带任意多个 512 B 包** —— 所以"每片一次 transferOut"是主机侧自找的开销（每次 ~150 µs ⇒ 44 ms/帧）。
  // 这条自测钉住两件事：① 攒批后调用次数掉到 ~11 次/帧；② 设备（假探针按 512 B 槽解析）收到的
  // 协议帧数与不攒批时**完全一样**。
  const run = async (batchBytes, ms) => ev(`
    const sel = document.getElementById('pn-batch');
    sel.value = '${batchBytes}'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const p = window.__tools.spiSession.mockProbe;
    p.resetState();
    document.getElementById('pn-anim-play').click();
    await new Promise(r => setTimeout(r, ${ms}));
    document.getElementById('pn-anim-stop').click();
    await new Promise(r => setTimeout(r, 500));
    const a = window.__tools.panel.summary().anim;
    return { a, framesOk: p.stats.framesOk, framesErr: p.stats.framesErr,
             perFrame: a.frames ? p.stats.framesOk / a.frames : 0 };`);

  const big = await run(16384, 1200);
  ok(big.a.callsPerFrame > 0 && big.a.callsPerFrame <= 12,
     `16 KB 攒批：每帧只喊 ${big.a.callsPerFrame} 次 USB（不攒批要 ~290 次）`);
  ok(big.framesErr === 0, `攒批后设备侧零错误（frames_err=${big.framesErr}）`);
  ok(Math.abs(big.perFrame - 292) <= 6,
     `设备侧每帧收到的协议帧数不变：${big.perFrame.toFixed(1)} ≈ 292（289 片 + 3 条命令）`);

  const small = await run(512, 1200);
  ok(small.a.callsPerFrame >= 250,
     `512 B 档 = 老行为：每帧 ${small.a.callsPerFrame} 次调用（一包一次 transferOut）`);
  ok(Math.abs(small.perFrame - big.perFrame) <= 6 && small.framesErr === 0,
     `两档的设备侧帧数一致（${small.perFrame.toFixed(1)} vs ${big.perFrame.toFixed(1)}）—— 攒批只改提交粒度`);

  // 收尾：把档位放回默认的 16 KB，别影响后面的用例
  await ev(`const sel = document.getElementById('pn-batch');
            sel.value = '16384'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 1;`);
}

// ==================================================================== 9e
console.log('== 9e. 回读：读寄存器 + 读 GRAM（假探针 GRAM → 预览 → BMP）==');
{
  // 用户 2026-10 的需求："spi/qspi 屏的回读功能（读一般都是 1 线读）：读寄存器；读 gram 值
  // （发 2A+2B 开窗，2E 读数据，3E 是续读），把读出的数据还原成一帧图片并显示在预览窗口，
  // 并提供保存为 bmp 的功能。"
  // 位置也按用户要求钉住：日志在「面板初始化」**前**面，读回在初始化**后**面。
  const order = await ev(`return [...document.querySelectorAll('#tab-panel .main > fieldset')].map(f => f.id);`);
  ok(order.join(',') === 'pn-img-card,pn-log-card,pn-code-card,pn-read-card',
     `屏页卡片顺序：图片 → 日志 → 面板初始化 → 读回（${order.join(' → ')}）`);

  const reg = await ev(`
    const s = window.__tools.spiSession;
    document.getElementById('pn-read-reg').value = '4';
    document.getElementById('pn-read-reg').dispatchEvent(new Event('change'));
    document.getElementById('pn-read-reg-go').click();
    await new Promise(r => setTimeout(r, 500));
    return { reg: window.__tools.panel.summary().lastReg,
             out: document.getElementById('pn-read-reg-out').textContent,
             cmd: document.getElementById('pn-read-reg-cmd').value, len: document.getElementById('pn-read-reg-len').value };`);
  ok(reg.reg?.bytes === 3 && reg.reg.hex === '00 93 96',
     `读寄存器 RDDID 04h → ${reg.reg?.hex}（假探针的确定值；下拉选中会自动填命令/长度：${reg.cmd}/${reg.len}）`);

  const rb = await ev(`
    const RD = await import('./app/spi/panel-read.js');
    const s = window.__tools.spiSession;
    // 前面几节往假探针的 GRAM 里写过东西（刷图/动画），这里换回干净的面板：
    // 假探针的"没写过的像素"是**确定性图案**，所以可以逐像素断言。
    document.getElementById('pn-geom').value = 'axs15352';
    document.getElementById('pn-geom').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    s.mockProbe.setPanelGeometry(240, 296);
    document.getElementById('pn-read-x0').value = 8; document.getElementById('pn-read-y0').value = 4;
    document.getElementById('pn-read-x1').value = 47; document.getElementById('pn-read-y1').value = 23;
    const p = s.mockProbe;
    p.resetState();
    await window.__tools.panel.readGram();
    const r = window.__tools.panel.summary().readBack;
    const canvas = document.getElementById('pn-canvas');
    const px = [...canvas.getContext('2d').getImageData(8, 4, 1, 1).data];
    const bmp = RD.encodeBMP(window.__tools.panel.readBack.rgba, r.w, r.h);
    const dv = new DataView(bmp.buffer);
    return { r, px, progress: document.getElementById('pn-read-prog').textContent,
             bmp: { len: bmp.length, magic: String.fromCharCode(bmp[0], bmp[1]), w: dv.getInt32(18, true), h: dv.getInt32(22, true), bpp: dv.getUint16(28, true) },
             wire: p.wireLog.filter(x => /GRAM|寄存器/.test(x)).slice(0, 5) };`);
  // 假探针的图案在 (8,4)：r = round(8*31/239)=1、g = round(4*63/295)=1、b = (8^4)&31=12 → RGB565 0x082C
  ok(rb.r?.bytes === 40 * 20 * 2 && rb.r.chunks === 4 && rb.r.missed === 0,
     `读回 40×20：${rb.r?.bytes} B / ${rb.r?.chunks} 片 / 丢 ${rb.r?.missed} 片（${rb.progress}）`);
  ok(rb.r?.sample?.[0]?.join(',') === '8,4,98',
     `解码后的第一个像素 = 假探针图案的 (8,4) → (${rb.r?.sample?.[0]?.join(',')})`);
  ok(rb.px?.join(',') === '8,4,98,255', `预览框里画的就是它（canvas(8,4) = ${rb.px?.join(',')}）`);
  ok(rb.bmp.magic === 'BM' && rb.bmp.w === 40 && rb.bmp.h === 20 && rb.bmp.bpp === 24 && rb.bmp.len === 54 + 40 * 3 * 20,
     `BMP：${rb.bmp.w}×${rb.bmp.h} 24bpp · ${rb.bmp.len} B（54 + 40×3×20）`);

  // 读回用的是"读"时序，不该把屏上的内容改掉：整场里没有任何 GRAM 写
  const clean = await ev(`const w = window.__tools.spiSession.mockProbe.wireLog.filter(x => /^GRAM 写/.test(x)).length; return w;`);
  ok(clean === 0, `读回全程只读不写（GRAM 写 ${clean} 次）`);
}

// ==================================================================== 10
console.log('== 10. 收尾 ==');
{
  const done = await ev(`
    await window.__tools.spiSession.teardown();
    await new Promise(r => setTimeout(r, 300));
    return { bus: window.__tools.spi.summary(), pn: window.__tools.panel.summary(),
             pnState: document.getElementById('pn-state').textContent };`);
  ok(done.bus.connected === false && done.pn.connected === false, 'teardown 后两页都显示未连接');
  ok(/未连接/.test(done.pnState), `屏页状态行 = ${done.pnState}`);
  const err = await ev(`return window.__tools.summary().errors;`);
  ok(err.length === 0, '整场跑完页面无未捕获错误', JSON.stringify(err));
}

console.log(`\n${fail ? '❌' : '✅'} spi-panel-page.test: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
