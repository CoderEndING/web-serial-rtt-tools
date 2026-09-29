/**
 * 真机场景编排（用户点名的 4 步）：
 *   1) 烧「狂发固件」→ 测 RTT Viewer 速率 → 测 RTT 转发速率
 *   2) 烧「scope 固件」→ 测 J-Scope：1 个变量 / 3 个变量 的采样率
 *   3) 上面 1)+2) 重复 3 遍
 *   4) 狂发 ↔ scope 交替烧录 5 遍，逐次计时
 *
 *   node tools/selftest/hw-campaign.mjs [--cycles=3] [--alt=5] [--com=COM5] [--chip=stm32f103] [--keep-going]
 *                                                                          （等价：make hw-campaign）
 *
 * 前置：8899 静态服务 + 9333 CDP 浏览器（`make hw-campaign` 会自己拉起来，见 Makefile 的 page-prep）
 * 结果同时写 tmp/campaign-result.json（中途崩了也不丢已测得的数据）。
 *
 * 🚨 **出错就立刻抛**（2026-10 用户现场要求："不能等它跑完了看"）：任何一步失败都会**马上中止**、
 *    打印原因并退 1；要继续跑剩下的用 `--keep-going`。开跑前还会做一次前置检查，
 *    并且**自己把芯片选成 STM32F103** —— 那次事故就是共享测试 profile 里 `f-chip`
 *    被上一次自测留在 `hpm6800evk`（flash 基址 0x80000000），于是每次烧 STM32 固件都报
 *    `固件段 0x8000000 不合法：地址 0x8000000 低于 flash 基址 0x80000000`。
 *
 * 2026-10 基线（STM32F103ZE + akaLinkPro；3 轮全场景 + 5 遍交替烧录，共 16 次烧录零失败）：
 *   烧录：狂发（0.9 KB 数据）≈ 0.72 s · scope（3.3 KB 数据）≈ 1.04 s
 *   RTT Viewer ≈ 240 KB/s（轮询 ~110 Hz）· RTT 转发 ≈ 384 KB/s（探针侧搬运 464 KB/s）
 *   J-Scope：1 变量上限 ≈ 397 kHz · 3 变量（相邻、合成 1 个 span）≈ 94 kHz ·
 *            3 变量（地址分散、3 个 span）≈ 60 kHz；这三档在 50 kHz 目标下都是 0 丢样本
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const APP = (process.env.APP || 'http://127.0.0.1:8899/index.html') + '?t=' + Date.now() + '#flash';
const FW_SPAM = '/tools/target-firmware/stm32f103_rtt_speed/build/fw.elf';   // 狂发 hello world
const FW_SCOPE = '/tools/target-firmware/stm32f103_scope/build/fw.elf';      // 19 个可采样变量
const COM = (process.argv.find(a => a.startsWith('--com=')) || '--com=COM5').split('=')[1];
const CHIP = (process.argv.find(a => a.startsWith('--chip=')) || '--chip=stm32f103').split('=')[1];
const KEEP_GOING = process.argv.includes('--keep-going');
const argN = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const CYCLES = argN('cycles', 3);
const ALT = argN('alt', 5);
const RTT_SECS = 6;        // RTT Viewer 测速窗口
const FWD_SECS = 8;        // RTT 转发测速窗口
const SCOPE_SECS = 3;      // 每次采样时长（目标侧真实时间，到点自动停）
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 硬看门狗（本机纪律：不许有无超时的等待）
const WD = setTimeout(() => { console.log('!! 看门狗超时，脚本退出'); dump(); process.exit(9); }, 15 * 60 * 1000);

/* ------------------------------------------------------------------ CDP */
class Cdp {
  constructor(){ this.seq = 0; this.pending = new Map(); this.handlers = new Map(); this.prompts = []; }
  _open(url, onMsg){
    const ws = new WebSocket(url);
    return new Promise((res, rej) => {
      ws.onopen = () => res(ws);
      ws.onerror = () => rej(new Error('CDP 连不上：' + url));
      ws.onmessage = ev => onMsg(ws, JSON.parse(ev.data));
    });
  }
  _dispatch(ws, m){
    if (m.id && this.pending.has(m.id)){
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      return;
    }
    if (!m.method) return;
    if (m.method === 'DeviceAccess.deviceRequestPrompted') this.prompts.push(m.params);
    const hs = this.handlers.get(m.method);
    if (hs) for (const h of hs) h(m.params);
  }
  async connect(){
    /**
     * 🚨 连不上 CDP 浏览器时给一句能照做的话：原始报错是 `TypeError: fetch failed … ECONNREFUSED`，
     *    看着像探针/板子的问题，其实就是"9333 上没浏览器"（2026-10 用户现场）。
     */
    let ver;
    try { ver = await (await fetch(CDP + '/json/version')).json(); }
    catch {
      throw new Error(`连不上 CDP 浏览器（${CDP}）—— 真页面测试需要它。` +
        '先 `make open`（起 8899 静态服务 + 9333 浏览器）；或者直接用 `make hw-campaign`，它会把这两样拉起来。');
    }
    this.browserWs = await this._open(ver.webSocketDebuggerUrl, (ws, m) => this._dispatch(ws, m));
    const list = await (await fetch(CDP + '/json/list')).json();
    const page = list.find(t => t.type === 'page' && t.url.includes('8899'));
    if (!page) throw new Error('没有 8899 的页面目标');
    this.ws = await this._open(page.webSocketDebuggerUrl, (ws, m) => this._dispatch(ws, m));
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    try { await this.send('Network.enable'); await this.send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
    // 页面里可能有 confirm()（烧录前问"RTT 正占用探针，要断开吗"）—— 一律自动确认
    this.on('Page.javascriptDialogOpening', () => { this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    try { await this.sendBrowser('DeviceAccess.enable'); } catch { try { await this.send('DeviceAccess.enable'); } catch {} }
    return this;
  }
  send(method, params = {}){ return this._call(this.ws, method, params); }
  sendBrowser(method, params = {}){ return this._call(this.browserWs, method, params); }
  _call(ws, method, params){
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`CDP ${method} 超时`)); }, 60000);
    });
  }
  on(m, fn){ if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(fn); }
  async eval(expr, userGesture = false){
    const r = await this.send('Runtime.evaluate', { expression: expr, userGesture, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
    return r.result.value;
  }
  async evalJson(expr){ return JSON.parse(await this.eval(`(async()=>JSON.stringify(await (${expr})))()`)); }
  async waitFor(expr, timeout = 15000, label = expr){
    const t0 = Date.now();
    for (;;){
      await pump();
      let v = false;
      try { v = await this.eval(`!!(${expr})`); } catch {}
      if (v) return true;
      if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label);
      await sleep(150);
    }
  }
}

/* ------------------------------------------------- 设备授权框：一律自动选 */
async function pump(){
  if (!cdp.prompts.length) return;
  const p = cdp.prompts.shift();
  const dev = p.devices.find(d => /akaLink|DAP|CMSIS|MicroLink|串行|Serial/i.test(d.name)) || p.devices[0];
  if (!dev) return;
  try {
    await cdp.sendBrowser('DeviceAccess.selectPrompt', { id: p.id, deviceId: dev.id });
    console.log(`   [授权框] 选中：${dev.name}`);
  } catch (e){ console.log('   [授权框] 选择失败：' + e.message); }
}
/** 带"授权框泵"的等待 */
async function nap(ms){
  const t0 = Date.now();
  for (;;){
    await pump();
    const left = ms - (Date.now() - t0);
    if (left <= 0) return;
    await sleep(Math.min(200, left));
  }
}

const cdp = await new Cdp().connect();
console.log(`== 真机场景测试 ==  CDP ${CDP}  串口 ${COM}`);
console.log(`   计划：${CYCLES} 轮 × (狂发→RTT Viewer ${RTT_SECS}s→RTT 转发 ${FWD_SECS}s→scope→J-Scope 5 组) ＋ 交替烧录 ${ALT} 遍`);

/**
 * 前置检查：**自己把芯片/后端设好**，不信浏览器里存着的那一份。
 * 🚨 2026-10 用户现场：每次烧录都报
 *    `固件段 0x8000000 不合法：地址 0x8000000 低于 flash 基址 0x80000000` ——
 *    因为共享的测试 profile 里 `f-chip` 被上一次自检留在了 **hpm6800evk**（RISC-V，
 *    flash 在 0x80000000），而这里烧的是 STM32 固件（0x08000000）。报错看着像固件坏了。
 */
async function preflight(){
  const st = await cdp.evalJson(`(()=>{
    document.querySelector('.tab[data-tab="flash"]').click();
    const c = document.getElementById('f-chip');
    if (!c) throw new Error('页面上没有 #f-chip（页面没加载完？）');
    const before = c.value;
    c.value = ${JSON.stringify(CHIP)};
    c.dispatchEvent(new Event('change'));
    const b = document.getElementById('f-backend');
    b.value = 'webusb'; b.dispatchEvent(new Event('change'));
    const v = document.getElementById('f-verify'); if (v) v.checked = true;
    const r = document.getElementById('f-reset'); if (r) r.checked = true;
    // RTT Viewer 那一格也复位：地址格留空 = 让页面自己扫（存着的旧地址会把扫描限死在一个地方）
    const ra = document.getElementById('r-addr'); if (ra) ra.value = '';
    return { before, chip: c.value, chipText: c.options[c.selectedIndex]?.textContent || '', backend: b.value };
  })()`);
  console.log(`   前置：芯片 ${st.before || '(空)'} → ${st.chip}（${st.chipText}）· 后端 ${st.backend} · 校验/复位已勾`);
  if (st.chip !== CHIP) throw new Error(`芯片下拉里没有 ${CHIP}（拿到「${st.chip}」）—— 页面模块是不是没加载完？`);
  return st;
}
await preflight();

const report = { startedAt: new Date().toISOString(), com: COM, cycles: [], alt: [], notes: [], errors: [] };
const dump = () => { try { fs.writeFileSync('tmp/campaign-result.json', JSON.stringify(report, null, 1)); } catch {} };

/* --------------------------------------------------------------- 烧录 */
/**
 * 把探针"交出来"：RTT 会话断开、J-Scope 让出、转发停掉并**关掉它的 HID 句柄**。
 * 为什么连 HID 也要关：同一个页面里两个 AkaLinkHid 同时开着会互相收到对方的 inputreport
 * （探针 HID 是共享设备），命令回执可能串台 —— 各页面自己的注释里也强调了这一点。
 */
async function quietProbe(){
  await cdp.eval(`(async()=>{ const t=window.__tools;
      try{ await t.rtt.disconnect(); }catch(e){}
      try{ await t.scope.releaseProbe('准备切换'); }catch(e){}
      try{ await t.hid.stop(); }catch(e){}
      try{ await t.hid.dev?.close?.(); }catch(e){} })()`).catch(() => {});
  await nap(250);
}

async function flash(fw, label){
  await quietProbe();
  await cdp.eval(`document.querySelector('.tab[data-tab="flash"]').click()`);
  const f = await cdp.evalJson(`(async()=>{ const r=await fetch(${JSON.stringify(fw)},{cache:'reload'});
      if(!r.ok) throw new Error('HTTP '+r.status); const b=await r.arrayBuffer();
      await window.__tools.flash._onFile(new File([b], ${JSON.stringify(fw.split('/').pop())}));
      return { name: window.__tools.flash.file.name, size: window.__tools.flash.file.size }; })()`);
  await cdp.eval(`document.getElementById('f-log').textContent=''; document.getElementById('f-result').textContent='—';`);
  const t0 = Date.now();
  await cdp.eval(`document.getElementById('f-flash').click()`, true);
  let started = false;
  for (let i = 0; i < 60; i++){
    await pump();
    if (await cdp.evalJson(`!!window.__tools.flash.busy`)){ started = true; break; }
    await sleep(100);
  }
  for (let i = 0; i < 600; i++){
    await pump();
    const busy = await cdp.evalJson(`!!window.__tools.flash.busy`);
    if (!busy) break;
    await sleep(150);
  }
  const wall = Date.now() - t0;
  const st = await cdp.evalJson(`({ res: document.getElementById('f-result').textContent,
      log: document.getElementById('f-log').textContent.split('\\n') })`);
  const sum = [...st.log].reverse().find(l => l.includes('耗时小结')) || '';
  const okFlash = st.res.includes('✅');
  console.log(`   [烧录] ${label}：${(wall / 1000).toFixed(1)}s ${okFlash ? '✅' : '❌ ' + st.res}`);
  if (sum) console.log('          ' + sum);
  /**
   * 🚨 **烧录没成就是硬错误**：以前只往 report.errors 里记一笔、继续往下测 ——
   *    结果后面的 RTT/J-Scope 数据全是在旧固件上量的（用户现场："固件没有烧录进去，
   *    你不能等它跑完了看啊"）。这里直接抛，让调用方立刻停。
   */
  if (!okFlash){
    const tail = st.log.filter(Boolean).slice(-5).join('\n          ');
    throw new Error(`${label} 烧录失败：${st.res}${tail ? `\n          页面日志尾部：\n          ${tail}` : ''}`);
  }
  return { label, fw: f.name, size: f.size, ms: wall, ok: okFlash, result: st.res, summary: sum, started };
}

/* ------------------------------------------- 场景 A：RTT Viewer 速率 */
async function rttViewer(secs){
  await cdp.eval(`document.querySelector('.tab[data-tab="rtt"]').click()`);
  await cdp.eval(`(()=>{const b=document.getElementById('r-backend'); b.value='webusb'; b.dispatchEvent(new Event('change'));})()`);
  await cdp.eval(`document.getElementById('r-range').value='0x20000000-0x20005000'`);
  await nap(600);                       // 刚烧完的会话要一点时间把接口/链路还回来
  /**
   * 🚨 **连不上就等 2 s 再点一次**（最多 3 次）：这是这套工具**已知且写在界面提示里**的现象 ——
   *    刚断开探针的会话（烧录器就是）浏览器释放 USB 接口要一会儿，紧接着连 Viewer 会撞上
   *    `Unable to claim interface` 或者正好读到上一场的脏响应（`ACK=5` 之类）。
   *    用户的手动操作就是"再点一次"，这里照做；三次都失败才抛，并把**页面上的原因**一起带上。
   */
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++){
    await cdp.eval(`document.getElementById('r-usb-connect').click()`, true);
    try {
      await cdp.waitFor(`window.__tools.rtt.rtt`, attempt === 1 ? 12000 : 9000, 'RTT 控制块定位');
      lastErr = '';
      break;
    } catch (e){
      const st = await cdp.evalJson(`({ probe: !!window.__tools.rtt.probe, err: document.getElementById('r-err').textContent,
          cb: document.getElementById('r-cb').textContent, addr: document.getElementById('r-addr').value })`);
      lastErr = `${e.message} ——「probe=${st.probe} · 控制块=${st.cb} · 地址格=${st.addr || '(空)'} · 状态栏=${st.err || '—'}」`;
      console.log(`   [RTT Viewer] 第 ${attempt} 次没连上，等 2 s 重试：${lastErr}`);
      try { await cdp.eval(`window.__tools.rtt.disconnect()`); } catch {}
      await nap(2000);
    }
  }
  if (lastErr) throw new Error(`RTT Viewer 连不上（试了 3 次）：${lastErr}`);
  await cdp.waitFor(`window.__tools.rtt.running`, 5000, 'RTT 轮询在跑');
  const a = await cdp.evalJson(`({b:window.__tools.rtt.stats.bytes,p:window.__tools.rtt.stats.polls,t:performance.now()})`);
  await nap(secs * 1000);
  const b = await cdp.evalJson(`({b:window.__tools.rtt.stats.bytes,p:window.__tools.rtt.stats.polls,t:performance.now(),
      lost:window.__tools.rtt.stats.lost, corrupt:window.__tools.rtt.stats.corrupt,
      rate:document.getElementById('r-rate').textContent, hz:document.getElementById('r-hz').textContent,
      full:document.getElementById('r-full').textContent, cb:document.getElementById('r-cb').textContent,
      up:document.getElementById('r-up').textContent, down:document.getElementById('r-down').textContent,
      err:document.getElementById('r-err').textContent })`);
  const dt = (b.t - a.t) / 1000;
  const out = { bytesPerSec: Math.round((b.b - a.b) / dt), kibPerSec: +(((b.b - a.b) / 1024) / dt).toFixed(1),
                pollHz: +((b.p - a.p) / dt).toFixed(1), seconds: +dt.toFixed(1),
                pageRate: b.rate, pageHz: b.hz, lost: b.lost, corrupt: b.corrupt, full: b.full,
                cb: b.cb, up: b.up, down: b.down, err: b.err };
  console.log(`   [RTT Viewer] ${(out.bytesPerSec / 1024).toFixed(1)} KB/s（页面显示 ${out.pageRate} · 轮询 ${out.pollHz} Hz · 控制块 ${out.cb} · up ${out.up}）`);
  await cdp.eval(`window.__tools.rtt.disconnect()`).catch(() => {});
  await nap(300);
  return out;
}

/* ------------------------------------------- 场景 B：RTT 转发速率 */
async function rttForward(secs){
  await cdp.eval(`document.querySelector('.tab[data-tab="rttcdc"]').click()`);
  // 探针连接：先走"已授权直连"（不弹框），不通再点「连接探针」走授权框
  await cdp.eval(`document.getElementById('h-reconnect').click()`, true);
  await nap(800);
  if (!await cdp.evalJson(`!!window.__tools.hid.dev?.connected`)){
    await cdp.eval(`document.getElementById('h-connect').click()`, true);
    await nap(1200);
  }
  await cdp.waitFor(`window.__tools.hid.dev?.connected`, 15000, 'HID 探针连接');
  // 主机侧读者：探针往 CDC 灌，不读会背压（那样测出来的速率是假的）
  fs.rmSync('tmp/com-read.json', { force: true });
  const reader = spawn('python', ['tools/selftest/com-read.py', COM, String(secs + 2), 'tmp/com-read.json'], { stdio: 'ignore' });
  await nap(900);
  await cdp.eval(`document.getElementById('h-auto').click()`, true);      // 自动搜控制块 + 启动转发
  try { await cdp.waitFor(`window.__tools.hid.last?.running`, 10000, '转发已启动'); }
  catch { console.log('   [RTT 转发] 等 running 超时，继续量'); }
  const a = await cdp.evalJson(`({m:window.__tools.hid.last?.moved||0, t:performance.now()})`);
  await nap(secs * 1000);
  const b = await cdp.evalJson(`({m:window.__tools.hid.last?.moved||0, t:performance.now(),
      state:document.getElementById('h-state').textContent, info:document.getElementById('h-info').textContent,
      cb:window.__tools.hid.last?.cbAddr||0, mhz:window.__tools.hid.last?.swdMhz||0, rdErr:window.__tools.hid.last?.rdErr||0 })`);
  await cdp.eval(`document.getElementById('h-stop').click()`, true);
  await new Promise(res => { const to = setTimeout(res, (secs + 8) * 1000); reader.on('exit', () => { clearTimeout(to); res(); }); });
  let host = { rate: 0, bytes: 0, head: '', error: '没读到结果文件' };
  try { host = JSON.parse(fs.readFileSync('tmp/com-read.json', 'utf8')); } catch {}
  const dt = (b.t - a.t) / 1000;
  const out = { hostBytesPerSec: host.rate, hostBytes: host.bytes, hostSeconds: host.seconds,
                hostHead: (host.head || '').replace(/\s+/g, ' ').slice(0, 80), hostError: host.error || '',
                probeMovedPerSec: Math.round((b.m - a.m) / dt), probeMoved: b.m, seconds: +dt.toFixed(1),
                state: b.state, cb: b.cb ? '0x' + Number(b.cb).toString(16) : '', mhz: b.mhz, rdErr: b.rdErr, info: b.info };
  console.log(`   [RTT 转发] 主机读 ${(out.hostBytesPerSec / 1024).toFixed(1)} KB/s（${out.hostBytes} B/${out.hostSeconds}s） · 探针侧搬运 ${(out.probeMovedPerSec / 1024).toFixed(1)} KB/s`
    + (out.hostError ? ' · 串口错误：' + out.hostError : '') + (out.hostHead ? ` · 样本「${out.hostHead.slice(0, 40)}」` : ''));
  await nap(300);
  return out;
}

/* ------------------------------------------- 场景 C：J-Scope 采样率 */
async function scopeEnsureElf(){
  const r = await cdp.evalJson(`(async()=>{ const s=window.__tools.scope;
      if (s.all && s.all.length) return { cached:true, n:s.all.length };
      const res=await fetch(${JSON.stringify(FW_SCOPE)},{cache:'reload'}); const b=await res.arrayBuffer();
      await s.loadElfFile(new File([b],'fw.elf'));
      return { cached:false, n:(s.all||[]).length }; })()`);
  if (!r.n) throw new Error('scope 固件里没解析出变量');
  return r;
}
async function scopeVars(){
  return await cdp.evalJson(`window.__tools.scope.all.map((v,i)=>({i,name:v.name,addr:v.addr,scalar:v.scalar,size:v.size}))`);
}
async function scopeConnect(){
  // 转发页的 HID 句柄先关掉，别和波形页的抢同一台 HID 设备
  await cdp.eval(`(async()=>{ try{ await window.__tools.hid.stop(); }catch(e){}
                              try{ await window.__tools.hid.dev?.close?.(); }catch(e){} })()`).catch(() => {});
  await nap(300);
  // HID：先用"已授权直连"，没有授权记录再点按钮走弹框（pump 会自动选 akaLinkPro）
  await cdp.eval(`(async()=>{ const s=window.__tools.scope; if(!s.hid) await s.connectHid(false); })()`);
  if (!await cdp.evalJson(`!!window.__tools.scope.hid`)){
    console.log('   [J-Scope] HID 未授权 → 点「连接探针」等授权框');
    await cdp.eval(`document.getElementById('sc-connect').click()`, true);
    await nap(2000);
  }
  // 数据端点（EP 0x83，WebUSB）
  await cdp.eval(`(async()=>{ const s=window.__tools.scope; if(!s.transport) await s.connectUsb(false); })()`);
  if (!await cdp.evalJson(`!!window.__tools.scope.transport`)){
    console.log('   [J-Scope] 数据端点未连 → 点「连接数据端点…」');
    await cdp.eval(`document.getElementById('sc-usb').click()`, true);
    await nap(2000);
  }
  return { hid: await cdp.evalJson(`!!window.__tools.scope.hid`),
           usb: await cdp.evalJson(`!!window.__tools.scope.transport`),
           info: await cdp.evalJson(`document.getElementById('sc-info').textContent`),
           usbinfo: await cdp.evalJson(`document.getElementById('sc-usbinfo').textContent`) };
}

async function scopeRun({ idxs, periodUs, secs, label }){
  await cdp.eval(`document.querySelector('.tab[data-tab="scope"]').click()`);
  const conn = await scopeConnect();
  if (!conn.hid || !conn.usb){
    const msg = `J-Scope 链路没连上（hid=${conn.hid} usb=${conn.usb} · ${conn.info} / ${conn.usbinfo}）`;
    console.log('   !! ' + msg);
    report.errors.push(label + '：' + msg);
  }
  const sel = await cdp.evalJson(`(()=>{ const s=window.__tools.scope; s.selected=[];
      for (const i of ${JSON.stringify(idxs)}) s.toggleVar(s.all[i], true);
      document.getElementById('sc-period').value=String(${periodUs});
      document.getElementById('sc-seconds').value=String(${secs});
      s.updatePlan();
      return { vars:s.selected.map(v=>v.name+'@0x'+v.addr.toString(16)),
               spans:s.plan.spans.length, frameBytes:s.plan.frameBytes, estUs:+s.plan.estUs.toFixed(2), estHz:s.plan.estHz }; })()`);
  const t0 = Date.now();
  await cdp.eval(`window.__tools.scope.start()`);
  let autoStopped = false;
  for (let i = 0; i < (secs + 12) * 5; i++){
    await pump();
    const st = await cdp.evalJson(`({running:!!window.__tools.scope.running, count:window.__tools.scope.store?.count||0,
        state:String(window.__tools.scope.state||''), err:document.getElementById('sc-err').textContent})`);
    if (!st.running && st.count > 0){ autoStopped = true; break; }
    if (!st.running && i > 6 && (/失败|错误|没连|先选|先连/.test(st.state) || st.err)){
      report.errors.push(`${label}：J-Scope 起不来 —— ${st.state} ${st.err}`);
      console.log(`   !! J-Scope 起不来：${st.state} ${st.err}`);
      break;
    }
    await sleep(200);
  }
  if (!autoStopped) await cdp.eval(`window.__tools.scope.stop('测试收尾')`).catch(() => {});
  await nap(400);
  const sum = await cdp.evalJson(`window.__tools.scope.summary()`);
  const wall = Date.now() - t0;
  const out = { label, periodUs, wantHz: Math.round(1e6 / periodUs), vars: sel.vars, spans: sel.spans,
                frameBytes: sel.frameBytes, estUs: sel.estUs, estHz: sel.estHz,
                samples: sum.samples, rateHz: sum.rateHz, packets: sum.packets,
                lostProbe: sum.lostProbe, lostUsb: sum.lostUsb, lostGap: sum.lostGap,
                state: sum.state, autoStopped, wallMs: wall };
  console.log(`   [J-Scope] ${label}：${sel.vars.length} 变量 ${sel.spans} span/${sel.frameBytes}B · 实测 ${(out.rateHz / 1000).toFixed(2)} kHz（名义 ${(out.wantHz / 1000).toFixed(1)} kHz）· ${out.samples} 样本 · 丢：探针 ${out.lostProbe} / USB ${out.lostUsb} / 缺口 ${out.lostGap}`);
  return out;
}

/** 选变量：1 个 = 顶层标量；3 个 = 三个**不同地址**的顶层标量；再给一组"地址分散"的（3 个 span，最费） */
function chooseVars(meta){
  const ok = meta.filter(v => v.scalar);
  const top = ok.filter(v => !v.name.includes('.'));
  const pool = top.length >= 4 ? top : ok;
  const one = pool.find(v => /g_lfsr|g_tick|g_loops|g_bytes|g_updates/i.test(v.name)) || pool[0];
  const three = [one];
  for (const v of pool){ if (three.length >= 3) break; if (!three.some(x => x.i === v.i) && v.addr !== one.addr) three.push(v); }
  // 分散组：按地址排序后取 首/中/尾 —— 三者互不相邻，读计划会被拆成 3 个 span
  const byAddr = [...pool].sort((a, b) => a.addr - b.addr);
  const spread = byAddr.length >= 3 ? [byAddr[0], byAddr[(byAddr.length / 2) | 0], byAddr[byAddr.length - 1]] : three;
  return { one: [one.i], three: three.map(v => v.i), spread: spread.map(v => v.i),
           oneName: one.name, threeNames: three.map(v => v.name), spreadNames: spread.map(v => v.name) };
}

/* ------------------------------------------------------------------ 主流程 */
/**
 * 出错**立刻停**（不跑完再看）：每轮/每遍自己 try，失败就打印原因、dump 已测数据、然后抛出；
 * 只有显式给了 `--keep-going` 才继续跑剩下的。最外层接住它，照样把"已经量到的"汇总出来。
 */
let aborted = null;
try {
for (let c = 1; c <= CYCLES; c++){
  console.log(`\n========== 第 ${c}/${CYCLES} 轮 ==========`);
  const rec = { cycle: c };
  let err = null;
  try {
    rec.flashSpam = await flash(FW_SPAM, `狂发 #${c}`);
    rec.rtt = await rttViewer(RTT_SECS);
    rec.fwd = await rttForward(FWD_SECS);
    rec.flashScope = await flash(FW_SCOPE, `scope #${c}`);
    rec.elf = await scopeEnsureElf();
    const meta = await scopeVars();
    const picks = chooseVars(meta);
    const say = `变量：1 个 = ${picks.oneName}；3 个 = ${picks.threeNames.join(', ')}；分散 3 个 = ${picks.spreadNames.join(', ')}`;
    console.log('   ' + say);
    rec.picks = picks;
    rec.s1_fast = await scopeRun({ idxs: picks.one, periodUs: 2, secs: SCOPE_SECS, label: '1 变量 @2µs（冲上限）' });
    rec.s1_50k = await scopeRun({ idxs: picks.one, periodUs: 20, secs: SCOPE_SECS, label: '1 变量 @20µs（50 kHz 目标）' });
    rec.s3_fast = await scopeRun({ idxs: picks.three, periodUs: 2, secs: SCOPE_SECS, label: '3 变量 @2µs（冲上限）' });
    rec.s3_50k = await scopeRun({ idxs: picks.three, periodUs: 20, secs: SCOPE_SECS, label: '3 变量 @20µs（50 kHz 目标）' });
    rec.s3spread = await scopeRun({ idxs: picks.spread, periodUs: 2, secs: SCOPE_SECS, label: '3 变量·地址分散 @2µs' });
  } catch (e){ err = e; }
  report.cycles.push(rec);
  dump();
  if (err){
    console.log(`\n!! 第 ${c} 轮出错，立刻停：${err.message}`);
    report.errors.push(`第 ${c} 轮：${err.message}`);
    if (!KEEP_GOING) throw new Error(`第 ${c} 轮出错：${err.message}`);
    console.log('   （--keep-going：继续下一轮）');
  }
}

console.log(`\n========== 阶段 4：狂发 ↔ scope 交替烧录 ${ALT} 遍 ==========`);
for (let i = 1; i <= ALT; i++){
  let err = null;
  try {
    const a = await flash(FW_SPAM, `交替#${i} 狂发`);
    const b = await flash(FW_SCOPE, `交替#${i} scope`);
    report.alt.push({ i, spamMs: a.ms, spamOk: a.ok, scopeMs: b.ms, scopeOk: b.ok, spamSum: a.summary, scopeSum: b.summary });
  } catch (e){ err = e; }
  dump();
  if (err){
    console.log(`\n!! 交替第 ${i} 遍出错，立刻停：${err.message}`);
    report.errors.push(`交替 ${i}：${err.message}`);
    if (!KEEP_GOING) throw new Error(`交替第 ${i} 遍出错：${err.message}`);
    console.log('   （--keep-going：继续下一遍）');
  }
}
} catch (e){
  aborted = e;
}

/* ------------------------------------------------------------------ 汇总 */
console.log('\n================ 汇总 ================');
for (const r of report.cycles){
  if (!r.rtt) continue;
  console.log(`第 ${r.cycle} 轮：烧狂发 ${(r.flashSpam.ms / 1000).toFixed(1)}s · RTT Viewer ${(r.rtt.bytesPerSec / 1024).toFixed(1)} KB/s @${r.rtt.pollHz}Hz`
    + ` · 转发 ${(r.fwd.hostBytesPerSec / 1024).toFixed(1)} KB/s · 烧 scope ${(r.flashScope.ms / 1000).toFixed(1)}s`);
  for (const k of ['s1_fast', 's1_50k', 's3_fast', 's3_50k', 's3spread']){
    const s = r[k]; if (!s) continue;
    console.log(`        ${s.label}：${(s.rateHz / 1000).toFixed(2)} kHz（${s.spans} span/${s.frameBytes}B · ${s.samples} 样本，丢 探针${s.lostProbe}/USB${s.lostUsb}/缺口${s.lostGap}）`);
  }
}
if (report.alt.length){
  const spam = report.alt.map(a => a.spamMs / 1000), scope = report.alt.map(a => a.scopeMs / 1000);
  const avg = a => (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2);
  console.log(`交替烧录：狂发 ${spam.map(x => x.toFixed(1)).join('/')}s（均 ${avg(spam)}s）· scope ${scope.map(x => x.toFixed(1)).join('/')}s（均 ${avg(scope)}s）`);
}
if (report.errors.length) console.log('错误：' + JSON.stringify(report.errors));
const errs = await cdp.evalJson(`window.__tools.errors`).catch(() => []);
if (errs.length) console.log('页面 JS 错误：' + JSON.stringify(errs).slice(0, 300));
dump();
clearTimeout(WD);
if (aborted){
  console.log('\n❌ 已中止：' + (aborted?.message || aborted));
  console.log('   （出错就立刻停 —— 想跑完剩下的用 --keep-going；上面的汇总只有中止前测到的部分）');
} else if (!report.errors.length){
  console.log('\n✅ 全部跑完，没有错误');
}
console.log('\n结果已写 tmp/campaign-result.json');
process.exit(aborted || report.errors.length ? 1 : 0);
