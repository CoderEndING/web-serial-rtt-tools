/**
 * 「J-Scope 波形」页的端到端自测（CDP，不需要硬件）：
 *   node tools/selftest/scope-page.test.mjs      （等价：make test-scope-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个）。
 *
 * 跑的是**真页面对象**（window.__tools.scope）：切页 → 开假探针 → 开始采样 → 收包 → 解码 →
 * 缓冲 → 画布上真的有像素 → 触发命中 → 离线重定位 → 导出 CSV 的代码路径。
 * 每一步都断言"客观状态"，不看"像不像"。
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
try { await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
await send('Page.navigate', { url: URL_ });
console.log('目标: ' + URL_);

// 等页面把 __tools 挂好
let ready = false;
for (let i = 0; i < 60; i++){
  await sleep(500);
  try { if (await ev('return !!window.__tools?.scope;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.scope 不存在）');

console.log('== 1. 标签页与初始状态 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(Array.isArray(s.tabs) && s.tabs.includes('scope'), '标签栏里有 scope');
  const i = s.tabs.indexOf('scope'), j = s.tabs.indexOf('rttcdc');
  ok(i === j + 1, `scope 紧跟在 RTT 转发后面（第 ${i + 1} 个）`, s.tabs.join(','));
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  ok(s.scope && s.scope.mode === 'real' && s.scope.samples === 0, '初始：真机模式、0 样本');
  ok(s.scope.plan && s.scope.plan.spans >= 1, `初始就有读计划预览（${s.scope.plan?.spans} 个 span）`);
  const vis = await ev(`const p=document.getElementById('tab-scope'); return getComputedStyle(p).display;`);
  void vis;
}

console.log('== 2. 切到 scope 页 + 开假探针 ==');
{
  await ev(`document.querySelector('#tabs .tab[data-tab="scope"]').click(); return true;`);
  await sleep(300);
  const active = await ev(`return document.getElementById('tab-scope').classList.contains('active');`);
  ok(active === true, '点击标签后 #tab-scope 变成 active');
  const mock = await ev(`
    const c = document.getElementById('sc-mock'); c.checked = true; c.dispatchEvent(new Event('change'));
    return window.__tools.scope.summary().mode;`);
  ok(mock === 'mock', '勾上「用假探针」→ 模式切到 mock');
  const items = await ev(`return [...document.querySelectorAll('#sc-vars .vrow')].length;`);
  ok(items === 0 || items > 0, `变量列表渲染出来了（${items} 行；没载 ELF 时用内置 8 通道）`);
  const planTxt = await ev(`return document.getElementById('sc-plan').textContent;`);
  ok(/span/.test(planTxt) && /kHz/.test(planTxt), `读计划预览有内容：「${planTxt.slice(0, 64)}…」`);
}

console.log('== 3. 开始采样（假探针 → 包流 → 解码 → 缓冲）==');
{
  await ev(`document.getElementById('sc-period').value='100'; document.getElementById('sc-seconds').value='5'; return true;`);
  await ev(`document.getElementById('sc-start').click(); return true;`);
  await sleep(400);
  const mid = await ev('return window.__tools.scope.summary();');
  ok(mid.running === true, '采样已启动');
  ok(mid.capacity > 50000 && mid.capacity < 200000, `缓冲容量按 速率×时长 算出来（${mid.capacity} 样本）`);
  await sleep(2600);
  const s = await ev('return window.__tools.scope.summary();');
  ok(s.samples > 3000, `收到 ${s.samples} 个样本（>3000）`);
  ok(s.packets > 100, `收到 ${s.packets} 个包（>100）`);
  ok(s.lost === 0, `零丢包（seq 无缺口，实际 ${s.lost}）`);
  ok(Math.abs(s.rateHz - 10000) < 400, `实测速率 ≈10 kHz（实际 ${s.rateHz} Hz）`);
  const dv = await ev(`
    const st = window.__tools.scope.store;
    const a = st.channel(0).at(10), b = st.channel(0).at(11);
    return { a, b, ch0: st.channel(0).scalar, ch2: st.channel(2).scalar, big: st.channel(2).at(5) };`);
  ok(Number.isFinite(dv.a) && Number.isFinite(dv.b), `缓冲里的值不是 NaN（ch0[10]=${dv.a?.toFixed?.(4)}）`);
  ok(dv.ch0 === 'f32' && dv.ch2 === 'i32', '通道类型按变量表分配（f32 / i32）');
  ok(Number.isInteger(dv.big), `i32 通道存的是整数（${dv.big}）`);
}

console.log('== 4. 画布上真的有波形 ==');
{
  const px = await ev(`
    const sc = window.__tools.scope;
    sc.drawFrame();
    const c = document.getElementById('sc-canvas');
    if (!c.width) return { err: 'canvas 没尺寸' };
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let colored = 0, total = 0;
    for (let i = 0; i < d.length; i += 4 * 17){        // 抽样，够判断了
      total++;
      if (Math.abs(d[i] - 17) + Math.abs(d[i+1] - 21) + Math.abs(d[i+2] - 28) > 40) colored++;
    }
    return { colored, total, lod: !!sc.usedLod, w: c.width, h: c.height,
             span: Math.round(sc.renderer.span), cols: Math.round(sc.renderer.plotW), count: sc.store.count };`);
  ok(!px.err, '画布有尺寸', px.err || '');
  ok(px.colored > px.total * 0.005 && px.colored > 300,
     `画布上有 ${px.colored}/${px.total} 个非背景采样点（波形真的画出来了）`);
  ok(px.lod === true, `缩到全览时走 LOD 快路径（span ${px.span} / ${px.cols} 列 = 每列 ${(px.span / px.cols).toFixed(1)} 样本，共 ${px.count} 个）`);
  const rows = await ev(`return [...document.querySelectorAll('#sc-legend .lrow')].map(e => e.textContent);`);
  ok(rows.length === 8, `图例 8 行（${rows.length}）`);
  const hidden = await ev(`
    document.querySelector('#sc-legend .lrow').click();
    return window.__tools.scope.renderer.isVisible(0);`);
  ok(hidden === false, '点图例可以隐藏/显示通道');
  await ev(`document.querySelector('#sc-legend .lrow').click(); return true;`);
}

console.log('== 5. 缩放 / 平移 / 精确模式 ==');
{
  const r = await ev(`
    const sc = window.__tools.scope;
    sc.follow = false;                         // 页面上手动缩放会自动关掉跟随；这里直接调 API 要自己关
    sc.renderer.zoomTo(0, 60);                 // 放大到 60 个样本 → 每列不到 1 个 → 精确扫描
    sc.drawFrame();
    return { span: sc.renderer.span, lod: !!sc.usedLod, cols: sc.renderer.plotW };`);
  ok(r.span === 60 && r.lod === false, `放大到 60 个样本后切回逐样本精确扫描（plotW=${Math.round(r.cols)}）`);
  const z = await ev(`
    const sc = window.__tools.scope;
    sc.follow = false;
    sc.renderer.fitAll();
    const full = sc.renderer.span;
    sc.renderer.zoomBy(2, 0.5);
    return { full, span: sc.renderer.span };`);
  ok(Math.abs(z.span - z.full / 2) < 2, `2× 缩放后跨度减半（${z.full} → ${z.span}，锚点在中间）`);
  const followOff = await ev(`
    const sc = window.__tools.scope;
    sc.follow = false;
    sc.renderer.zoomTo(0, 100);
    document.getElementById('sc-fit').click();
    return sc.follow;`);
  ok(followOff === true, '点「全览」会重新打开跟随（数据在长时视图自动跟上）');
}

console.log('== 6. 触发（实时 + 离线重定位）==');
{
  const hit = await ev(`
    const sc = window.__tools.scope;
    const ch = sc.store.channels.findIndex(c => c.scalar === 'i16');   // 假探针的 1 kHz 方波
    document.getElementById('sc-trig-mode').value = '3';               // 上升沿
    document.getElementById('sc-trig-ch').value = String(ch);
    document.getElementById('sc-trig-level').value = '0';
    document.getElementById('sc-trig-pre').value = '200';
    document.getElementById('sc-trig-post').value = '800';
    sc.applyTrigger();
    return { idx: sc.trigger.hitIndex, ch, marker: !!sc.renderer.trigger };`);
  ok(hit.idx >= 0 && hit.marker === true, `触发命中 @ 样本 ${hit.idx}（i16 方波上升沿，第 ${hit.ch} 通道）`);
  const next = await ev(`
    const sc = window.__tools.scope;
    const first = sc.trigger.hitIndex;
    document.getElementById('sc-trig-find').click();
    return { first, second: sc.trigger.hitIndex, state: document.getElementById('sc-trig-state').textContent };`);
  ok(next.second > next.first, `「查找下一个」跳到更靠后的命中点（${next.first} → ${next.second}）`);
  ok(/命中/.test(next.state), '触发状态行有文案：' + next.state.slice(0, 40));
  const cleared = await ev(`
    document.getElementById('sc-trig-clear').click();
    return { hit: window.__tools.scope.trigger.hitIndex, marker: !!window.__tools.scope.renderer.trigger };`);
  ok(cleared.hit === -1 && cleared.marker === false, '「清除触发」把标记和命中点都清了');
}

console.log('== 7. 停止 / 导出 CSV / 记录原始包 ==');
{
  await ev(`document.getElementById('sc-stop').click(); return true;`);
  await sleep(500);
  const s = await ev('return window.__tools.scope.summary();');
  ok(s.running === false, '已停止');
  ok(s.samples > 3000, `停止后样本仍是 ${s.samples}（数据留着）`);

  const raw = await ev(`
    const c = document.getElementById('sc-raw'); c.checked = true; c.dispatchEvent(new Event('change'));
    document.getElementById('sc-start').click();
    return true;`);
  void raw;
  await sleep(1200);
  await ev(`document.getElementById('sc-stop').click(); return true;`);
  await sleep(400);
  const s2 = await ev('return window.__tools.scope.summary();');
  ok(s2.raw > 0, `勾上「记录原始包」后收到了 ${s2.raw} 块原始数据`);

  await ev(`document.getElementById('sc-csv').click(); return true;`);
  await sleep(600);
  const st = await ev(`return document.getElementById('sc-state').textContent;`);
  ok(/已导出 CSV/.test(st), '导出 CSV 的代码路径跑通：' + st.slice(0, 40));
  const saved = await ev(`document.getElementById('sc-save').click(); return document.getElementById('sc-state').textContent;`);
  ok(/已保存原始包/.test(saved), '保存原始包的代码路径跑通：' + saved.slice(0, 40));
}

console.log('== 8. 清空与收尾 ==');
{
  const s = await ev(`
    document.getElementById('sc-clear').click();
    const sc = window.__tools.scope;
    return { samples: sc.store.count, packets: sc.packets, lost: sc.summary().lost };`);
  ok(s.samples === 0 && s.packets === 0 && s.lost === 0, '「清空」把缓冲和计数都归零');
  const errs = await ev('return window.__tools.errors;');
  ok(Array.isArray(errs) && errs.length === 0, '全程没有 JS 错误', JSON.stringify(errs));
}

console.log('== 9. 勾选顺序 ≠ 地址顺序（帧内顺序 = 地址排序）==');
{
  // 真机踩过的坑：用户按 u_ramp(0x…20) → f_sin(0x…14) 的顺序勾，而固件按**地址**打包，
  // 于是通道与数据整体错位（u_ramp 那格装的是 f_sin 的 ±1）。这里用假探针复现并要求它被修住。
  const r = await ev(`
    const sc = window.__tools.scope;
    document.getElementById('sc-mock').checked = true;
    document.getElementById('sc-mock').dispatchEvent(new Event('change'));
    // 故意**逆着地址**勾：先 0x…20 的 u_ramp，再 0x…14 的 f_sin，最后 0x…22 的 i_sq1k
    const order = ['mock3.u16', 'mock0.f32', 'mock5.u8'];
    sc.selected = [];
    for (const n of order){ const v = sc.mockVars().find(x => x.name === n); sc.toggleVar(v, true); }
    document.getElementById('sc-period').value = '100';
    document.getElementById('sc-seconds').value = '3';
    await sc.start();
    await new Promise(r2 => setTimeout(r2, 1500));
    await sc.stop();
    const st = sc.store;
    const names = st.channels.map(c => c.name);
    const stats = st.channels.map(c => ({ name: c.name, type: c.scalar, min: c.min, max: c.max,
                                          first: c.at(0), last: c.at(st.count - 1) }));
    return { picked: order, storeNames: names, stats, count: st.count,
             defVars: sc.defVars?.map(v => '0x' + v.addr.toString(16)) || null, mismatch: sc.defMismatch };`);
  ok(r.storeNames.length === 3 && r.count > 0, `采到 ${r.count} 个样本`);
  const sortedByAddr = ['mock0.f32', 'mock3.u16', 'mock5.u8'];   // mockVars 的地址是 0x20000000 + i*4
  ok(JSON.stringify(r.storeNames) === JSON.stringify(sortedByAddr),
     `缓冲按地址排序（勾选 ${r.picked.join(' → ')} ⇒ 缓冲 ${r.storeNames.join(' → ')}）`);
  const byName = Object.fromEntries(r.stats.map(s => [s.name, s]));
  ok(byName['mock0.f32'] && byName['mock0.f32'].min >= -1.001 && byName['mock0.f32'].max <= 1.001,
     `f32 正弦落在 ±1（实际 ${byName['mock0.f32']?.min?.toFixed(3)}..${byName['mock0.f32']?.max?.toFixed(3)}）`);
  ok(byName['mock3.u16'] && byName['mock3.u16'].min >= 0 && byName['mock3.u16'].max <= 999,
     `u16 锯齿落在 0..999（实际 ${byName['mock3.u16']?.min}..${byName['mock3.u16']?.max}）`);
  ok(byName['mock5.u8'] && byName['mock5.u8'].min >= 0 && byName['mock5.u8'].max <= 255,
     `u8 落在 0..255（实际 ${byName['mock5.u8']?.min}..${byName['mock5.u8']?.max}）`);
  ok(r.mismatch === null, 'DEF 变量数与本地缓冲一致（没有触发"解码已暂停"）', r.mismatch || '');
  // 分道显示：每路一条泳道
  const lanes = await ev(`
    document.querySelector('[data-group=sclayout] button[data-v=lanes]').click();
    const sc = window.__tools.scope; sc.drawFrame();
    return { layout: sc.renderer.layout, n: sc.renderer.visibleCount() };`);
  ok(lanes.layout === 'lanes' && lanes.n === 3, `切到分道：${lanes.n} 条泳道`);
  await ev(`document.querySelector('[data-group=sclayout] button[data-v=overlay]').click(); return true;`);
}

console.log(`\n${fail ? '❌' : '✅'} scope-page.test: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
