/**
 * 「调试器」页的端到端自测（CDP，**不需要硬件**）：
 *   node tools/selftest/dbg-page.test.mjs        （等价：make test-dbg-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个）。
 *
 * 跑的是**真页面对象**（`window.__tools.dbg` 是调试页视图）+ 页面里的**真按钮**，
 * 目标用内置的「模拟目标」（app/dbg/mock.js）——它有真的寄存器/内存/FPB 比较器，
 * 所以「下断点 → 继续 → 命中断点 → 单步 → 复位」这条链是在页面上真跑一遍的。
 * 符号用仓库里的真 ELF（tools/fixtures/dwarf/stm32f103_rtt_speed.elf，页面自己 fetch 得到）。
 *
 * 每一步都断言"客观状态"（会话里的寄存器/内存/断点表、DOM 里给用户看的文字），不看"像不像"。
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
/** 轮询等条件成立（页面里的表达式为真） */
async function until(expr, ms = 6000, step = 120){
  const t0 = Date.now();
  for (;;){
    if (await ev(`return !!(${expr});`)) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
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
  try { if (await ev('return !!window.__tools?.dbg;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.dbg 不存在）');

// ==================================================================== 1
console.log('== 1. 标签页与初始状态 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(Array.isArray(s.tabs) && s.tabs.includes('dbg'), '标签栏里有 dbg（调试器）');
  ok(s.tabs[s.tabs.length - 4] === 'dbg', `调试器排在烧录器之后（${s.tabs.join(' → ')}）`, s.tabs.join(','));
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  ok(s.dbg && s.dbg.connected === false, 'summary 里有 dbg 段且初始未连接');

  const dom = await ev(`
    document.querySelector('#tabs .tab[data-tab="dbg"]').click();
    await new Promise(r => setTimeout(r, 60));
    const sec = document.getElementById('tab-dbg');
    return { active: sec.classList.contains('active'),
             regs: document.getElementById('d-regs').children.length,
             mem: document.getElementById('d-mem').textContent.slice(0, 12),
             flag: document.getElementById('d-state').textContent,
             connectBtn: !!document.getElementById('d-connect') };`);
  ok(dom.active && dom.connectBtn, '切到调试器页，控件齐');
  ok(dom.regs === 1 && /未连接|没有数据/.test(dom.mem), '未连接时寄存器/内存区显示占位提示', JSON.stringify(dom));
  ok(dom.flag === '未连接', '状态灯显示未连接');
}

// ==================================================================== 2
console.log('== 2. 载入 ELF 符号（页面自己 fetch 仓库里的真 ELF）==');
{
  const r = await ev(`
    const res = await fetch('/tools/fixtures/dwarf/stm32f103_rtt_speed.elf');
    if (!res.ok) throw new Error('取 ELF 失败 ' + res.status);
    const buf = await res.arrayBuffer();
    const st = window.__tools.dbg.loadElfBuffer(buf, 'stm32f103_rtt_speed.elf');
    return { n: st ? st.size : 0, vars: st ? st.varCount : 0, info: document.getElementById('d-elf-info').textContent };`);
  ok(r.n > 50 && r.vars > 0, `符号载入：${r.n} 个符号、${r.vars} 个带类型变量`, JSON.stringify(r));
  ok(/符号/.test(r.info), '侧栏显示符号摘要', r.info);
}

// ==================================================================== 3
console.log('== 3. 连接模拟目标 + 寄存器表 ==');
{
  const r = await ev(`
    document.getElementById('d-backend').value = 'mock';
    document.getElementById('d-backend').dispatchEvent(new Event('change'));
    const okc = await window.__tools.dbg.connect();
    return { okc, sum: window.__tools.dbg.summary() };`);
  ok(r.okc === true && r.sum.connected, '连上模拟目标', JSON.stringify(r.sum));
  ok(r.sum.regs === 23, `读到 23 个寄存器（含 CFBP 拆出的 4 个）`, String(r.sum.regs));
  ok(r.sum.bpCap === 8, '读到 FPB 硬件断点上限 8');
  ok(r.sum.pc === 0x08000100, 'PC = 复位向量', '0x' + r.sum.pc.toString(16));
  ok(r.sum.clockKhz === 1000, '默认 SWD 时钟 1 MHz（PPB 访问的硬要求）');

  const dom = await ev(`
    const rows = [...document.querySelectorAll('#d-regs .regrow')];
    return { rows: rows.length,
             first: rows[0]?.textContent.trim(),
             pcRow: rows.find(r => r.querySelector('.rn').textContent === 'PC')?.querySelector('input').value,
             note: rows.find(r => r.querySelector('.rn').textContent === 'PC')?.querySelector('.note').textContent || '',
             flag: document.getElementById('d-state').textContent,
             stepDisabled: document.getElementById('d-step').disabled,
             pcText: document.getElementById('d-pc').textContent };`);
  ok(dom.rows === 23 && /^R0/.test(dom.first), '寄存器表渲染出 23 行', JSON.stringify(dom));
  ok(dom.pcRow === '0x08000100', 'PC 行的值是 0x08000100', dom.pcRow);
  ok(/[A-Za-z_][\w.]*\+0x[0-9a-f]+/.test(dom.note) || dom.note === '', 'PC 行旁边的符号落点（有符号表就显示函数名+偏移）', dom.note);
  ok(dom.flag === '已停止' && dom.stepDisabled === false, '状态灯=已停止，单步可用');
  ok(/PC 0x08000100/.test(dom.pcText), '工具条上显示 PC', dom.pcText);
}

// ==================================================================== 4
console.log('== 4. 单步 / 继续 / 暂停（真按钮）==');
{
  await ev(`document.getElementById('d-step').click(); await new Promise(r=>setTimeout(r,300));`);
  const r = await ev('return window.__tools.dbg.summary();');
  ok(r.pc === 0x08000102, '点「单步」走了一条指令（PC +2）', '0x' + r.pc.toString(16));
  ok(r.halted === true, '单步后仍是停止状态');

  const cont = await ev(`
    document.getElementById('d-cont').click();
    await new Promise(r=>setTimeout(r, 300));
    const d = window.__tools.dbg;
    return { sum: d.summary(), livePc: await d.session.readReg('PC') };`);
  ok(cont.sum.halted === false, '点「继续」之后目标在跑');
  ok(cont.livePc !== 0x08000102, '目标真的在往前走（直接读 PC 看）', '0x' + cont.livePc.toString(16));

  await sleep(300);
  const stillRunning = await ev('return !window.__tools.dbg.session.halted;');
  ok(stillRunning, '没有断点时它会一直跑（观察循环不会误判成"已停止"）');

  await ev(`document.getElementById('d-halt').click(); await new Promise(r=>setTimeout(r,300));`);
  const st = await ev('return { h: window.__tools.dbg.session.halted, flag: document.getElementById("d-state").textContent };');
  ok(st.h && st.flag === '已停止', '点「暂停」能停住', JSON.stringify(st));
}

// ==================================================================== 5
console.log('== 5. 命令行 ==');
const outText = () => ev('return document.getElementById("d-out").textContent;');
{
  const run = async line => {
    await ev(`document.getElementById('d-cmd').value = ${JSON.stringify(line)};
              document.getElementById('d-run').click();
              await new Promise(r=>setTimeout(r, 250));`);
    return await outText();
  };

  let t = await run('h');
  ok(/md <地址>/.test(t) && /b <地址\|符号>/.test(t), 'h 打出帮助', t.slice(-120));

  t = await run('r');
  ok(/R0/.test(t) && /XPSR/.test(t) && /CONTROL/.test(t), 'r 打印全部寄存器（含 CFBP 拆出的特殊寄存器）');

  t = await run('r r0 0x1234');
  ok(/R0/.test(t) && /0x00001234/.test(t), 'r r0 <值> 写入并回显');
  const r0 = await ev('return await window.__tools.dbg.session.readReg("R0");');
  ok(r0 === 0x1234, '页面会话里的 R0 真的变了', '0x' + r0.toString(16));

  t = await run('mw 0x20000040 de ad be ef');
  ok(/回读一致/.test(t), 'mw 写内存并回读对账', t.slice(-100));
  t = await run('md 0x20000040 16');
  ok(/0x20000040  DE AD BE EF/.test(t), 'md 的 hexdump 内容正确', t.slice(-160));

  t = await run('p g_bytes');
  ok(/g_bytes/.test(t), 'p <变量> 从 ELF 符号里找到了变量', t.slice(-120));

  t = await run('sym RTT');
  ok(/_SEGGER_RTT/.test(t), 'sym <子串> 搜符号');

  t = await run('b SysTick_Handler');
  ok(/断点 #1/.test(t) && /SysTick_Handler/.test(t), 'b <符号> 下硬件断点（符号解析）', t.slice(-120));
  const bpl = await ev('return document.getElementById("d-bp-list").textContent;');
  ok(/SysTick_Handler/.test(bpl), '侧栏断点列表里出现了它', bpl);
  t = await run('bl');
  ok(/#1/.test(t) && /硬件上限 8/.test(t), 'bl 列出断点与硬件上限');

  t = await run('nosuchcmd');
  ok(/不认识的命令/.test(t), '不认识的命令给红字提示（不静默）', t.slice(-80));
}

// ==================================================================== 6
console.log('== 6. 断点：继续 → 命中 → 再继续（跨过断点）==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    await d.session.bpClear();
    await d.session.writeReg('PC', 0x08000200);
    await d.session.refreshRegs();
    d.renderRegs(); d.renderBps();
    await d.runLine('b 0x08000300');
    await d.runLine('c');                      // 命令行的「继续」
    return { bps: d.session.bps.map(a=>'0x'+a.toString(16)), wires: !!d.watching };`);
  ok(r.bps.length === 1 && r.bps[0] === '0x8000300', '下了一个断点', JSON.stringify(r));
  ok(await until('window.__tools.dbg.session.halted', 6000), '继续之后命中断点并停下');
  const hit = await ev(`
    const d = window.__tools.dbg;
    return { pc: d.session.pc, out: document.getElementById('d-out').textContent };`);
  ok(hit.pc === 0x08000300, 'PC 停在断点地址上', '0x' + hit.pc.toString(16));
  ok(/命中断点/.test(hit.out), '命令行里明确写了「命中断点」', hit.out.slice(-120));

  // 再继续：会话内部要"先单步跨过断点"，然后绕一圈再命中
  await ev(`
    window.__tools.dbg.runLine('c');
    await new Promise(r=>setTimeout(r, 50));
    return 1;`);
  ok(await until('window.__tools.dbg.session.halted', 8000), '第二次继续后仍然会命中（没有卡在断点上）');
  const pc2 = await ev('return window.__tools.dbg.session.pc;');
  ok(pc2 === 0x08000300, '还是同一个断点地址', '0x' + pc2.toString(16));

  // 侧栏的「×」删断点
  const after = await ev(`
    document.querySelector('#d-bp-list .bprow button').click();
    await new Promise(r=>setTimeout(r, 250));
    return { n: window.__tools.dbg.session.bps.length, text: document.getElementById('d-bp-list').textContent };`);
  ok(after.n === 0 && /还没有断点/.test(after.text), '点断点列表里的 × 能删掉', JSON.stringify(after));
}

// ==================================================================== 7
console.log('== 7. 寄存器 / 内存的界面编辑 ==');
{
  const r = await ev(`
    const rows = [...document.querySelectorAll('#d-regs .regrow')];
    const inp = rows.find(r => r.querySelector('.rn').textContent === 'R1').querySelector('input');
    inp.value = '0xCAFEBABE';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return { v: await window.__tools.dbg.session.readReg('R1'),
             shown: inp.value, out: document.getElementById('d-out').textContent.slice(-80) };`);
  ok(r.v === 0xcafebabe, '在寄存器表里改 R1 并回车 → 真写进去了', JSON.stringify(r));
  ok(/0xCAFEBABE/i.test(r.shown), '输入框回填了读回值', r.shown);

  const mem = await ev(`
    // 打开「可写」，读一段内存，点一个字节，改它
    const w = document.getElementById('d-mem-write-on');
    w.checked = true; w.dispatchEvent(new Event('change'));
    document.getElementById('d-mem-addr').value = '0x20000080';
    document.getElementById('d-mem-len').value = '32';
    document.getElementById('d-mem-read').click();
    await new Promise(r => setTimeout(r, 300));
    const cells = [...document.querySelectorAll('#d-mem .by.w')];
    cells[2].click();                                  // 0x20000082
    const ea = document.getElementById('d-mem-ea').value;
    document.getElementById('d-mem-ev').value = '5A';
    document.getElementById('d-mem-write').click();
    await new Promise(r => setTimeout(r, 300));
    const bytes = await window.__tools.dbg.session.memRead(0x20000080, 4);
    return { ea, cells: cells.length, hex: [...bytes].map(b=>b.toString(16).padStart(2,'0')).join(' '),
             dump: document.getElementById('d-mem').textContent };`);
  ok(mem.cells >= 32, '内存区渲染出可点的字节格子', String(mem.cells));
  ok(/0x20000082/i.test(mem.ea), '点字节会把地址填进「改」那一行', mem.ea);
  ok(/^80 00 5a a5$/.test(mem.hex) || mem.hex.includes('5a'), '点格子改字节真的写进了内存', mem.hex);
  ok(/20000080/.test(mem.dump), 'dump 里的地址列正确', mem.dump.slice(0, 40));
}

// ==================================================================== 8
console.log('== 8. 复位与运行状态按钮 ==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    await d.session.bpClear();
    document.getElementById('d-reset-halt').click();
    await new Promise(r => setTimeout(r, 600));
    const a = { pc: d.session.pc, h: d.session.halted, flag: document.getElementById('d-state').textContent };
    document.getElementById('d-reset-run').click();
    await new Promise(r => setTimeout(r, 400));
    const b = { pc: d.session.pc, h: d.session.halted, flag: document.getElementById('d-state').textContent };
    document.getElementById('d-halt').click();
    await new Promise(r => setTimeout(r, 400));
    return { a, b, c: { h: d.session.halted } };`);
  ok(r.a.pc === 0x08000100 && r.a.h === true, '「复位并停」把 PC 拉回复位向量且停住', JSON.stringify(r.a));
  ok(r.b.h === false && r.b.flag === '运行中', '「复位并跑」进入运行状态', JSON.stringify(r.b));
  ok(r.c.h === true, '点「暂停」能停住', JSON.stringify(r.c));
}

// ==================================================================== 9
console.log('== 9. RTT 同屏（模拟目标里有一个合法的 RTT 控制块）==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    document.getElementById('d-rtt-addr').value = '0x20000100';
    document.getElementById('d-rtt-locate').click();
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('d-reset-run').click();          // 让它跑起来，假目标会往 RTT 环里写
    await new Promise(r => setTimeout(r, 1200));
    document.getElementById('d-halt').click();
    await new Promise(r => setTimeout(r, 400));
    return { rtt: d.rtt ? { addr: '0x' + d.rtt.addr.toString(16), maxUp: d.rtt.maxUp } : null,
             text: document.getElementById('d-rtt').textContent.slice(0, 200),
             info: document.getElementById('d-rtt-info').textContent };`);
  ok(r.rtt && r.rtt.addr === '0x20000100' && r.rtt.maxUp === 1, 'RTT 控制块定位成功', JSON.stringify(r.rtt));
  ok(/tick|dbg/.test(r.text), 'RTT 输出窗里真的出现了目标打印的内容', r.text.slice(0, 80));
}

// ==================================================================== 10
console.log('== 10. 断开 + 收尾 ==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    await d.disconnect();
    await new Promise(r => setTimeout(r, 200));
    // 把界面选项复原（本 profile 是共用的：留在"模拟目标"上会让下一个套件/下次手工打开时意外）
    const be = document.getElementById('d-backend');
    be.value = 'webusb'; be.dispatchEvent(new Event('change'));
    return { sum: d.summary(), flag: document.getElementById('d-state').textContent,
             bus: d.bus === window.__tools.probeBus, backend: be.value };`);
  ok(r.sum.connected === false && r.flag === '未连接', '断开后状态回到未连接', JSON.stringify(r.sum));
  ok(r.bus === true, '调试页挂着跨页签的探针协调对象（probeBus）');
  ok(r.backend === 'webusb', '收尾把后端选回 WebUSB（不给下一个套件留坑）', r.backend);
  const errs = await ev('return window.__tools.errors;');
  ok(Array.isArray(errs) && errs.length === 0, '整轮跑完页面没有未捕获错误', JSON.stringify(errs));
}

console.log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`);
try { ws.close(); } catch {}
process.exit(fail ? 1 : 0);
