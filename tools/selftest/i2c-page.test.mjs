/**
 * 「USB→I2C」页的端到端自测（CDP，**不需要硬件**）：
 *   node tools/selftest/i2c-page.test.mjs        （等价：make test-i2c-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个，见 page-prep）。
 *
 * 跑的是**真页面对象**（`window.__tools.i2c` 是本页视图），走的是**假探针**（内置
 * AT24C02/MPU6050/ADS1115/Si5351 四个假器件，传感器数据是活的）。
 * 每一步都断言"客观状态"（假器件里的内容、表格里的结果、解析出来的任务结构），不看"像不像"。
 *
 * 这里特别咬三件事：
 *   ① **表格与脚本区必须走同一套解析**（表格生成的脚本能被同一套 parser 解析、字段一致）；
 *   ② **while(1) 真的在定时跑**：实时值面板要有连续采样、曲线缓冲要长起来、停止要立刻停；
 *   ③ 排版回归：命令表的每个格子必须在 `<td>` 里（直接挂 `<tr>` 上会让整行竖着堆 —— 踩过）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const APP = process.env.APP || 'http://127.0.0.1:8899/index.html';
const URL_ = APP + '?t=' + Date.now() + '#i2c';

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
  try { if (await ev('return !!window.__tools?.i2c;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.i2c 不存在）');
// 自带前置：别的页面测试会把 localStorage 里的"当前标签"留在自己那一页，
// 不显式点一下的话本页可能根本没显示（各页测试都这么做，见 spi/scope/dbg 的 page 测试）
await ev(`document.querySelector('#tabs .tab[data-tab="i2c"]').click(); return true;`);
await sleep(200);

// ==================================================================== 1
console.log('== 1. 标签页与初始状态 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(s.tabs.includes('i2c'), '标签栏里有 i2c（USB→I2C）');
  ok(s.tabs[s.tabs.length - 2] === 'i2c' && s.tabs[s.tabs.length - 1] === 'gen',
     `i2c 排在「工程生成」前面（${s.tabs.slice(-3).join(' → ')}）`, s.tabs.join(','));
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  ok(s.i2c && s.i2c.connected === false, '初始：未连接');
  ok(s.i2c.rows === 3, `命令表默认 3 行（实际 ${s.i2c?.rows}）`);
  ok(s.i2c.preset === 'quick', '默认选中「快速上手」示例');
  const ta = await ev(`return document.getElementById('i2-dsl-text').value.slice(0, 20);`);
  ok(/快速上手/.test(ta), '脚本区载入了默认示例', ta);
  const disabled = await ev(`return document.getElementById('i2-scan').disabled;`);
  ok(disabled === true, '未连接时「扫描总线」是灰的');
}

// ==================================================================== 2
console.log('== 2. 命令表的排版与格子联动（踩过的坑）==');
{
  const lay = await ev(`
    const tr = document.querySelector('#i2-cmd-body tr');
    return {
      cells: tr.children.length,
      tags: [...tr.children].map(c => c.tagName),
      directInputs: [...tr.children].filter(c => c.tagName === 'INPUT' || c.tagName === 'SELECT').length,
      tops: [...tr.children].map(c => c.offsetTop),
    };`);
  ok(lay.cells === 9, `一行 9 个格子（实际 ${lay.cells}）`);
  ok(lay.tags.every(t => t === 'TD'), '🚨 每个格子都包在 <td> 里（直接挂 <tr> 上整行会竖着堆）', lay.tags.join(','));
  ok(lay.directInputs === 0, '……没有裸露的 input/select 直接挂在 <tr> 上');
  ok(new Set(lay.tops).size === 1, '……所有格子在同一行（offsetTop 一致）', JSON.stringify(lay.tops));

  const mask = await ev(`
    const t = window.__tools.i2c;
    t.rows = [{ op:'rd', dev:'0x68', addr:'0x3B', data:'', rd:'14', as:'ax=u8(0)', period:'' }];
    t._renderTable();
    const cells = t.rowEls[0].cells;
    const read = { data: cells.data.disabled, dev: cells.dev.disabled, rd: cells.rd.disabled, as: cells.as.disabled };
    t.rows[0].op = 'wr'; t._renderTable();
    const c2 = t.rowEls[0].cells;
    const write = { data: c2.data.disabled, rd: c2.rd.disabled, as: c2.as.disabled, dev: c2.dev.disabled };
    t.rows[0].op = 'delay'; t._renderTable();
    const c3 = t.rowEls[0].cells;
    const delay = { data: c3.data.disabled, dev: c3.dev.disabled, rd: c3.rd.disabled };
    return { read, write, delay };`);
  ok(mask.read.data === true && mask.read.rd === false && mask.read.as === false, '「读」：数据格灰掉、读长/解码可编辑', JSON.stringify(mask.read));
  ok(mask.write.data === false && mask.write.rd === true && mask.write.as === true, '「写」：读长/解码灰掉、数据可编辑', JSON.stringify(mask.write));
  ok(mask.delay.data === false && mask.delay.dev === true && mask.delay.rd === true, '「延时」：只有数据格（填时长）可编辑', JSON.stringify(mask.delay));
}

// ==================================================================== 3
console.log('== 3. 连接假探针 → 配置 → 使能 ==');
{
  const r = await ev(`
    const t = window.__tools.i2c;
    t.session.log = () => {};                    // 自测不刷日志 DOM（省时间）
    document.getElementById('i2-mock').checked = true;
    document.getElementById('i2-connect').click();
    await new Promise(r => setTimeout(r, 800));
    return { connected: t.session.connected, enabled: t.session.enabled,
             scl: t.session.actualSclHz, mock: t.session.usingMock,
             state: document.getElementById('i2-state').textContent,
             info: document.getElementById('i2-info').textContent,
             scanDisabled: document.getElementById('i2-scan').disabled };`);
  ok(r.connected === true && r.mock === true, '假探针已连接');
  ok(r.enabled === true, '连上后自动使能了（探针复位后桥是未使能状态）');
  ok(r.scl === 100000, `默认档 100 kHz（实际 ${r.scl}）`);
  ok(/已使能/.test(r.state), '状态栏说清了"桥已使能"', r.state);
  ok(/假探针/.test(r.info) && /已使能/.test(r.info), '连接信息显示假探针 + 已使能', r.info);
  ok(r.scanDisabled === false, '连接后「扫描总线」可点');

  const cfg = await ev(`
    const t = window.__tools.i2c;
    document.getElementById('i2-scl').value = '400000';
    document.getElementById('i2-pullup').checked = true;
    document.getElementById('i2-retries').value = '2';
    document.getElementById('i2-cfg-set').click();
    await new Promise(r => setTimeout(r, 400));
    return { cfg: t.session.cfg, actual: document.getElementById('i2-scl-actual').textContent };`);
  ok(cfg.cfg.sclHz === 400000 && cfg.cfg.actualSclHz === 400000, '写配置 → 400 kHz 生效');
  ok(cfg.cfg.pullup === 1 && cfg.cfg.retries === 2, '内部上拉 / 重试次数也写进去了');
  ok(/400 kHz/.test(cfg.actual), '「实际生效」那一行回读了 400 kHz', cfg.actual);
}

// ==================================================================== 4
console.log('== 4. 扫描总线 ==');
{
  await ev(`
    document.getElementById('i2-scan').click();
    await new Promise(r => setTimeout(r, 900));
    return true;`);
  const s = await ev(`
    return { sum: document.getElementById('i2-scan-sum').textContent,
             rows: [...document.querySelectorAll('#i2-scan-body tr')].map(tr => tr.children[0].textContent + '|' + tr.children[1].textContent),
             addrs: window.__tools.i2c.scanAddrs.map(a => '0x' + a.toString(16)) };`);
  ok(s.addrs.join(',') === '0x48,0x50,0x60,0x68', '扫到四个假器件', s.addrs.join(','));
  ok(s.rows.length === 4, '扫描结果表 4 行');
  ok(s.rows.some(r => /0x50\|AT24Cxx/.test(r)), '0x50 被认成 AT24Cxx EEPROM', s.rows.join(' / '));
  ok(s.rows.some(r => /0x68\|MPU6050/.test(r)), '0x68 被认成 MPU6050');

  const pick = await ev(`
    document.querySelectorAll('#i2-scan-body tr')[2].querySelector('button').click();
    await new Promise(r => setTimeout(r, 120));
    return { dev: document.getElementById('i2-dev').value,
             onRows: [...document.querySelectorAll('#i2-scan-body tr')].filter(tr => tr.classList.contains('on')).length };`);
  ok(pick.dev === '0x60', '点「选用」把地址填进了选中框', pick.dev);
  ok(pick.onRows === 1, '……并且高亮了那一行');
}

// ==================================================================== 5
console.log('== 5. 命令表：跑一次性 + while(1) 定时 ==');
{
  const one = await ev(`
    const t = window.__tools.i2c;
    t.rows = [
      { op:'rd', dev:'0x68', addr:'0x75', data:'', rd:'1', as:'id=u8(0)', period:'' },
      { op:'wr', dev:'0x50', addr:'0x00', data:'A5 5A DE AD BE EF 12 34', rd:'', as:'', period:'' },
      { op:'rd', dev:'', addr:'', data:'', rd:'', as:'', period:'' },          // 空器件 → 跳过
    ];
    t.results.clear(); t._renderTable();
    document.getElementById('i2-cmd-send').click();
    await new Promise(r => setTimeout(r, 1200));
    const res = [...document.querySelectorAll('#i2-cmd-body td.res')].map(td => td.textContent);
    const mem = t.session.hid.devices.get(0x50).mem;
    return { res, mem: [...mem.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join(' ') };`);
  ok(/68/.test(one.res[0]) && /id=104/.test(one.res[0]), '第 1 行读 WHO_AM_I → 68 且解出 id=104', one.res[0]);
  ok(/无数据/.test(one.res[1]), '第 2 行是写（没有回读数据）', one.res[1]);
  ok(/跳过/.test(one.res[2]), '空器件格的那一行被跳过并写明原因', one.res[2]);
  ok(one.mem === 'a5 5a de ad be ef 12 34', '🚨 写真的落到假器件里了（逐字节对得上）', one.mem);

  // 定时：把第 2 行换成 50ms 的读，跑起来看实时值
  const timed = await ev(`
    const t = window.__tools.i2c;
    t.rows = [
      { op:'rd', dev:'0x68', addr:'0x75', data:'', rd:'1', as:'id=u8(0)', period:'' },
      { op:'rd', dev:'0x68', addr:'0x3B', data:'', rd:'14', as:'ax=i16be(0)/16384, az=i16be(4)/16384', period:'50ms' },
      { op:'delay', dev:'—', addr:'', data:'5ms', rd:'', as:'', period:'' },
    ];
    t.results.clear(); t._renderTable();
    document.getElementById('i2-cmd-run').click();
    await new Promise(r => setTimeout(r, 1600));
    const running = t.runner.running;
    const live = t.live.get('ax');
    const snap = { running, vars: [...t.live.keys()], n: live ? live.n : 0, buf: live ? live.buf.length : 0, last: live ? live.last : null };
    document.getElementById('i2-cmd-stop').click();
    await new Promise(r => setTimeout(r, 500));
    return { ...snap, afterStop: t.runner.running, res1: document.querySelectorAll('#i2-cmd-body td.res')[1].textContent };`);
  ok(timed.running === true, 'while(1) 跑起来了');
  ok(timed.vars.includes('ax') && timed.vars.includes('az'), '实时值里有 ax / az 两个变量', timed.vars.join(','));
  ok(timed.n >= 20, `1.6 s 内按 50 ms 采了 ${timed.n} 次（应当 ≥20）`);
  ok(timed.buf === timed.n, '曲线缓冲跟采样次数同步长起来', String(timed.buf));
  ok(timed.last !== null && Number.isFinite(timed.last), 'ax 有实际数值', String(timed.last));
  ok(timed.afterStop === false, '点「停止」后不再跑');
  ok(/⟳/.test(timed.res1) && /实测/.test(timed.res1), '结果列显示了实测周期（定时行的拍数）', timed.res1);

  const liveDom = await ev(`
    return { rows: document.querySelectorAll('#i2-live-body tr').length,
             canvases: document.querySelectorAll('#i2-live-body canvas.spark').length,
             sum: document.getElementById('i2-live-sum').textContent };`);
  ok(liveDom.rows === 3, `实时值表 3 行（实际 ${liveDom.rows}）`);
  ok(liveDom.canvases === 3, '……每行一条迷你曲线');
  ok(/个变量/.test(liveDom.sum), '实时值摘要写明了变量数与采样数', liveDom.sum);
}

// ==================================================================== 6
console.log('== 6. 表格 ⇄ 脚本（同一套解析）==');
{
  const rt = await ev(`
    const t = window.__tools.i2c;
    t.rows = [
      { op:'rd', dev:'0x50', addr:'0x00', data:'', rd:'8', as:'', period:'' },
      { op:'wr', dev:'0x50', addr:'0x10', data:'A5 5A', rd:'', as:'', period:'' },
      { op:'delay', dev:'—', addr:'', data:'10ms', rd:'', as:'', period:'' },
      { op:'rd', dev:'0x68', addr:'0x3B', data:'', rd:'14', as:'ax=i16be(0)/16384', period:'100ms×5' },
    ];
    t._renderTable();
    document.getElementById('i2-dsl-fromtable').click();
    await new Promise(r => setTimeout(r, 250));
    const script = document.getElementById('i2-dsl-text').value;
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 250));
    return { script, sum: document.getElementById('i2-dsl-sum').textContent,
             errRows: document.querySelectorAll('#i2-dsl-err tr').length,
             tasks: window.__tools.i2c.runner.constructor ? null : null };`);
  ok(/rd 0x50 0x00 8/.test(rt.script), '命令表 → 脚本：读那一行', rt.script.split('\n').slice(0, 6).join(' | '));
  ok(/wr 0x50 0x10 A5 5A/.test(rt.script), '命令表 → 脚本：写那一行');
  ok(/delay 10ms/.test(rt.script), '命令表 → 脚本：延时那一行');
  ok(/every 100ms 5/.test(rt.script), '命令表 → 脚本：周期 100ms×5');
  ok(rt.errRows === 0, '生成的脚本零语法错');
  ok(/1 个循环任务/.test(rt.sum) && /100ms/.test(rt.sum), '解析摘要报出了循环任务与周期', rt.sum);

  const back = await ev(`
    const t = window.__tools.i2c;
    document.getElementById('i2-dsl-to-table').click();
    await new Promise(r => setTimeout(r, 250));
    return { rows: t.rows.map(r => [r.op, r.dev, r.addr, r.data, r.rd, r.as, r.period].join('|')),
             dom: document.querySelectorAll('#i2-cmd-body tr').length,
             sum: document.getElementById('i2-dsl-sum').textContent };`);
  ok(back.dom === 4, `脚本 → 命令表：装回 4 行（实际 ${back.dom}）`);
  ok(back.rows[0] === 'rd|0x50|0x00||8||', '……第 1 行字段原样', back.rows[0]);
  ok(back.rows[2] === 'delay|—||10ms|||', '……延时行的时长落在「数据」格', back.rows[2]);
  ok(back.rows[3] === 'rd|0x68|0x3B||14|ax=i16be(0)/16384|100ms×5', '……定时 + 解码都带回来了', back.rows[3]);
}

// ==================================================================== 7
console.log('== 7. 脚本区：预设 / 错误表 / 分片助手 ==');
{
  const pres = await ev(`
    const sel = document.getElementById('i2-preset');
    const opts = [...sel.options].map(o => o.value);
    sel.value = 'ads1115';
    document.getElementById('i2-dsl-load').click();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 200));
    return { opts, sum: document.getElementById('i2-dsl-sum').textContent,
             errRows: document.querySelectorAll('#i2-dsl-err tr').length,
             help: document.getElementById('i2-dsl-help').textContent.length };`);
  ok(pres.opts.join(',') === 'quick,at24c02-read,at24c02-write,mpu6050,ads1115,si5351',
     '示例下拉里有六个：快速上手 + 四个模块 + EEPROM 写', pres.opts.join(','));
  ok(/1 个循环任务/.test(pres.sum) && /200ms/.test(pres.sum), 'ADS1115 示例解析出 200 ms 的循环任务', pres.sum);
  ok(/12 条@200ms/.test(pres.sum), '……循环体是 12 条（四通道 × 写配置+等+读）', pres.sum);
  ok(pres.errRows === 0, 'ADS1115 示例零语法错');
  ok(pres.help > 800, `语法速查有内容（${pres.help} 字符）`);

  const bad = await ev(`
    const ta = document.getElementById('i2-dsl-text');
    const tooLong = Array(56).fill('11').join(' ');       // 56 B > 单次写上限 51
    ta.value = 'scan\\nrd 0x50 0x00 99\\nwr 0x50 0x00 ' + tooLong;
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 250));
    const rows = [...document.querySelectorAll('#i2-dsl-err tr')].map(tr => [...tr.children].map(td => td.textContent));
    return { n: rows.length, rows, sum: document.getElementById('i2-dsl-sum').textContent,
             visible: document.getElementById('i2-dsl-errwrap').style.display !== 'none' };`);
  ok(bad.n === 2, `两处语法错都列出来了（实际 ${bad.n}）`, JSON.stringify(bad.rows));
  ok(bad.rows.some(r => r[0] === '2' && /54/.test(r[2])), '第 2 行：读长超上限并说清上限是 54', JSON.stringify(bad.rows[0]));
  ok(bad.rows.some(r => r[0] === '3' && /51/.test(r[2])), '第 3 行：写数据超上限并说清上限是 51', JSON.stringify(bad.rows[1]));
  ok(bad.visible === true && /2 处语法错/.test(bad.sum), '错误表显示出来了，摘要点名了处数', bad.sum);

  const frag = await ev(`
    const ta = document.getElementById('i2-dsl-text');
    ta.value = '';
    document.getElementById('i2-frag-dev').value = '0x50';
    document.getElementById('i2-frag-addr').value = '0x00';
    document.getElementById('i2-frag-len').value = '256';
    document.getElementById('i2-frag-mode').value = 'ptr';
    document.getElementById('i2-frag-run').click();
    await new Promise(r => setTimeout(r, 250));
    const ptr = ta.value;
    document.getElementById('i2-frag-mode').value = 'reset';
    document.getElementById('i2-frag-run').click();
    await new Promise(r => setTimeout(r, 250));
    const both = ta.value;
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 250));
    return { ptr, both, errRows: document.querySelectorAll('#i2-dsl-err tr').length };`);
  ok(/^wr 0x50 0x00$/m.test(frag.ptr), '分片助手（地址指针自增）：先发一次零长度写把指针推过去', frag.ptr.split('\n').slice(1, 3).join(' | '));
  ok(/^rd 0x50 - 54$/m.test(frag.ptr) && /^rd 0x50 - 40$/m.test(frag.ptr), '……然后 54/54/54/54/40 分片，续片不带子地址');
  ok(/rd 0x50 0x36 54/.test(frag.both) && /rd 0x50 0x6C 54/.test(frag.both),
     '「每片重发子地址」那档按起始地址递增（0x00 → 0x36 → 0x6C → 0xA2 → 0xD8）',
     frag.both.split('\n').filter(l => /^rd/.test(l)).slice(-4).join(' | '));
  ok(frag.errRows === 0, '分片助手生成的脚本零语法错');
}

// ==================================================================== 8
console.log('== 8. 错误路径与状态显示 ==');
{
  const e = await ev(`
    const t = window.__tools.i2c;
    await t.session.setEnabled(false);
    const disabled = await t.session.transaction({ dev:0x50, addr:[0], wr:[], rd:1 }, { quiet:true });
    await t.session.transaction({ dev:0x21, addr:[0], wr:[], rd:1 }, { quiet:true });   // 不存在的地址
    await t.session.setEnabled(true);
    const noAddr = await t.session.transaction({ dev:0x21, addr:[0], wr:[], rd:1 }, { quiet:true });
    const pt = await t.session.pinTest();
    await t.session.readStatus({ quiet:true });
    return { disabled: disabled.err, noAddr: noAddr.err, bridgeOk: pt.bridgeOk,
             word: document.getElementById('i2-word').textContent,
             wordText: document.getElementById('i2-word-text').textContent,
             ok: document.getElementById('i2-c-ok').textContent,
             na: document.getElementById('i2-c-na').textContent,
             lastUs: document.getElementById('i2-last-us').textContent };`);
  ok(e.disabled === 1, '未使能时事务回 E_DISABLED(1)', String(e.disabled));
  ok(e.noAddr === 3, '不存在的地址回 E_NO_ADDR(3)', String(e.noAddr));
  ok(e.bridgeOk === true, 'PINTEST 判「桥这一侧正常」');
  ok(/^0x[0-9a-f]{8}$/.test(e.word), '状态字按 8 位十六进制显示', e.word);
  ok(/总线空闲/.test(e.wordText) && /SDA=1/.test(e.wordText), '状态字文字说明里有总线/线电平', e.wordText);
  ok(Number(e.ok) >= 4, `成功计数在涨（${e.ok}）`);
  ok(Number(e.na) >= 1, `地址 NACK 计数在涨（${e.na}）`);
  ok(Number(e.lastUs) > 0, `单笔耗时显示出来了（${e.lastUs} µs）`);

  // 坏行必须在结果列里当行报错，而不是等到发送才炸
  const badRow = await ev(`
    const t = window.__tools.i2c;
    t.rows = [{ op:'rd', dev:'0x50', addr:'0x00', data:'', rd:'99', as:'', period:'' }];
    t._renderTable();
    return { text: document.querySelector('#i2-cmd-body td.res').textContent,
             cls: document.querySelector('#i2-cmd-body td.res').className };`);
  ok(/✗/.test(badRow.text) && /54/.test(badRow.text), '填错的行在结果列里就报出来了', badRow.text);
  ok(/bad/.test(badRow.cls), '……并且染成错误色', badRow.cls);
}

// ==================================================================== 9
console.log('== 9. 收尾：放掉探针 ==');
{
  const done = await ev(`
    const t = window.__tools.i2c;
    t.runner.stop();
    await t.session.disconnect();
    await new Promise(r => setTimeout(r, 250));
    return { s: t.summary(), state: document.getElementById('i2-state').textContent };`);
  ok(done.s.connected === false, 'disconnect 后已放掉 HID');
  ok(done.s.running === false, '定时已停');
  const err = await ev('return window.__tools.summary().errors;');
  ok(err.length === 0, '整场跑完页面无未捕获错误', JSON.stringify(err));
}

console.log(`\n${fail ? '❌' : '✅'} i2c-page.test: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
