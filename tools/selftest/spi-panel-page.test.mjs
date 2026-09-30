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
  ok(L.cards[0] === 'pn-img-card' && L.cards[1] === 'pn-code-card',
     `主区顺序 = 刷图 → 面板初始化 → 日志（实测 ${L.cards.join(' → ')}）`);
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
  ok(applied.cfg.padDc === 0 && applied.cfg.padRst === 2 && applied.cfg.padBl === 3,
     `引脚按屏改了：DC=${applied.cfg.padDc}（不用）/ RST=PB12 / BL=PB13`);
  ok(/40 MHz/.test(applied.sum.sclk), `只读摘要显示 SCLK ${applied.sum.sclk}`);
  ok(/RST=PB12/.test(applied.sum.pads), `只读摘要显示引脚「${applied.sum.pads}」`);
  ok(/回读对账一致/.test(applied.log), '套用走的还是回读对账那条路（不靠状态字的 err）');

  const back = await ev(`
    document.getElementById('pn-preset').value = 'axs15352';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    const s = window.__tools.spiSession;
    return { prof: s.profile.profile, sclk: s.cfg.sclkHz, dc: s.cfg.padDc };`);
  ok(back.prof === 1 && back.sclk === 40000000 && back.dc === 1,
     `换回 AXS15352 → 档 1 + 40 MHz + DC=PB11（实测 ${back.prof}/${back.sclk}/${back.dc}）`);
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
    return { enabled: s.enabled, profile: s.profile?.profile, geom: document.getElementById('pn-geom').value,
             framesOk: p.stats.framesOk, framesErr: p.stats.framesErr,
             bytesTx: p.stats.bytesTx, ms: performance.now() - t0,
             prog: document.getElementById('pn-code-prog').textContent,
             log: document.getElementById('pn-log').textContent };`);
  ok(replay.enabled === true, '桥已使能（未使能时帧只会被 NAK）');
  ok(replay.profile === 2 && replay.geom === 'st77916', `已套用 ST77916：档 2 + 几何 st77916（实测 档${replay.profile} / ${replay.geom}）`);
  ok(replay.framesOk === 194 && replay.framesErr === 0, `192 条 + 2 条自动前缀全部执行成功（frames_ok=${replay.framesOk} err=${replay.framesErr}）`);
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
  ok(one.framesOk === 1 && one.wire.length === 1, `「单发」只发一条（${one.framesOk} 帧）`);
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
  ok(send.framesOk === 529 && send.framesErr === 0, `整屏 529 帧全成功（2 条开窗 + 527 片像素，实测 ${send.framesOk}）`);
  ok(send.bytesTx === 259200 + 16, `线上字节 = 像素 259200 + 开窗 16（实测 ${send.bytesTx}）`);
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
