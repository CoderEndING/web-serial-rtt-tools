/**
 * 调试器页（#dbg）**真机压力测试** —— 发布前的总验收（2026-10）
 *
 *   node tools/selftest/dbg-hw-stress.mjs
 *   node tools/selftest/dbg-hw-stress.mjs --elf=/tools/.../build-dw5/fw.elf    # 换 DWARF5 靶子
 *
 * 前置（跟其它页面套件一样）：
 *   1) 靶子固件已经烧进板子 —— tools/target-firmware/stm32h743_dbgstress/build/fw.elf
 *      （烧录：node tmp/dbg-flash.mjs /tools/target-firmware/stm32h743_dbgstress/build/fw.elf）
 *   2) 8899 静态服务 + 9333 调试浏览器在跑（make page-prep）
 *   3) akaLinkPro 探针插着，且**没有被别的工具占着**（OpenOCD/pyOCD 要先退掉）
 *
 * 与 `dbg-hw.mjs` / `tmp/dbg-hw-new.mjs` 的分工：那两个是"冒烟"，本文件是**压**：
 *   · 断点：文件:行 / 符号 / static 函数 / 函数+偏移 / 多断点 / ISR / 反复命中 / 越界与内联函数报错
 *   · 代码同步：每次停下都要 PC → 源码位置自洽（跨源文件、指令级步进时行号不跳）
 *   · 单步：O0 线性序列 20 步、si/si 进调用（含 **BLX Rn 间接调用**）、n 跳过调用、
 *           fin 逐层爬 5 层（含 **LR 被内部调用覆盖**的非叶子情形）
 *   · 复位重跑：复位必须停在**复位向量**上 → 断点仍然有效 → 再命中（连续 3 轮）
 *   · 监视 / 结构体树：位域与影子字逐位对账、复合路径、指针、char[]、越界报错
 *   · 泄漏：每一段之后 FPB 比较器必须"只剩用户断点占的那些"（直读 FP_COMP 核对）
 *   · 压力：连续 60 次停-走-停，看有没有比较器泄漏 / 页面未捕获错误
 *
 * 有 `tmp/gdb-oracle.json` 时（由 tmp/dbg-gdb-oracle.mjs 生成）会**逐地址比对**
 * "单步序列"与"断点落点" —— 与 arm-none-eabi-gdb 的结果必须完全一致，
 * 这是"和 MDK/gdb 一个水平"这句话的硬证据。
 */
import { Cdp, sleep, DEV_RE } from '../../tmp/cdp-lib.mjs';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : (argv.includes('--' + k) ? true : d); };

const APP = 'http://127.0.0.1:8899/index.html';
const ELF = String(arg('elf', '/tools/target-firmware/stm32h743_dbgstress/build/fw.elf'));
const SRCDIR = String(arg('src', 'E:\\web-serial-rtt-tools\\tools\\target-firmware\\stm32h743_dbgstress\\src'));
const SRC_ENGINE = String(arg('engine-c', SRCDIR + '\\engine.c'));
const ORACLE = String(arg('oracle', 'tmp/gdb-oracle.json'));
const JSON_OUT = String(arg('out', 'tmp/dbg-stress-page.json'));
setTimeout(() => { console.error('[WATCHDOG] 25 分钟'); process.exit(9); }, 1500000);

// 靶子源码里的两个关键行号（"调用 engine_leaf 的那一句" / "内联那一句"）—— 用来把
// "单步进入"和"内联不可下断点"钉在确定的位置上，而不是靠猜步数。
const engLines = readFileSync(SRC_ENGINE, 'utf8').split(/\r?\n/);
const CALL_LINE = engLines.findIndex(l => /engine_leaf\(a, 3u\)/.test(l)) + 1;
const CALL2_LINE = engLines.findIndex(l => /engine_leaf\(a, 5u\)/.test(l)) + 1;

const log = m => console.log(m);
let pass = 0, fail = 0;
const failures = [];
const sec = t => log('\n' + t);
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' —— ' + extra : '')); log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const hex = n => '0x' + ((n ?? 0) >>> 0).toString(16);

// ---------------------------------------------------------------- 连接
const cdp = new Cdp();
await cdp.connect();
await cdp.send('Page.navigate', { url: APP + '?t=' + Date.now() });
for (let i = 0; i < 80; i++){ await sleep(300); if (await cdp.eval('return !!window.__tools?.dbg;').catch(() => false)) break; }
await cdp.eval(`document.querySelector('#tabs .tab[data-tab="dbg"]').click(); await new Promise(r=>setTimeout(r,250)); return true;`);

/** 页面里的小工具（一次注入；`cmd()` 会丢掉回显行，`go/step` 会等到停下为止） */
await cdp.eval(`
  const d = window.__tools.dbg;
  window.__S = {
    d,
    async cmd(line){
      const el = document.getElementById('d-out');
      const n0 = el.children.length;
      const r = await d.runLine(line);
      let rows = [...el.children].slice(n0).map(c => c.textContent.trim());
      if (rows.length && rows[0].startsWith('>')) rows = rows.slice(1);      // 第一行是命令回显
      return { out: rows, err: r?.error || null, text: rows.join('\\n') };
    },
    snap(){
      const cur = document.querySelector('#d-src .srcrow.cur');
      return {
        pc: d.session.pc >>> 0, halted: !!d.session.halted, connected: !!d.session.connected,
        name: d.sym ? d.sym.nameOf(d.session.pc >>> 0) : '',
        pos: document.getElementById('d-src-pos').textContent,
        file: document.getElementById('d-src-file').textContent,
        bps: d.session.bpList().length, srcRows: document.querySelectorAll('#d-src .srcrow').length,
        curLine: cur ? Number(cur.dataset.line) : null,
        at: d.sym ? d.sym.at(d.session.pc >>> 0) : null,
      };
    },
    /** 继续运行，等到停下来（断点命中/手动暂停）或超时 */
    async go(ms = 4000){
      await d.session.cont();
      const t0 = Date.now();
      while (Date.now() - t0 < ms){
        await new Promise(r => setTimeout(r, 25));
        await d.session.refresh();
        if (d.session.halted) break;
      }
      if (d.session.halted) await d.afterStop();
      return this.snap();
    },
    /** 单步（n / si / fin / s），等到停下 */
    async step(cmd, ms = 4000){
      const el = document.getElementById('d-out');
      const n0 = el.children.length;
      await d.runLine(cmd);
      const t0 = Date.now();
      while (Date.now() - t0 < ms && !d.session.halted){ await new Promise(r => setTimeout(r, 25)); await d.session.refresh(); }
      if (d.session.halted) await d.afterStop();
      let rows = [...el.children].slice(n0).map(c => c.textContent.trim());
      if (rows.length && rows[0].startsWith('>')) rows = rows.slice(1);
      return { ...this.snap(), out: rows, text: rows.join('\\n') };
    },
    /** FPB 比较器占用：直读 FP_CTRL/FP_COMPx（泄漏检查的硬证据） */
    async fpb(){
      const raw = await d.session.memRead(0xE0002000, 36);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
      const ctrl = dv.getUint32(0, true);
      const comps = [];
      for (let i = 0; i < 8; i++) comps.push(dv.getUint32(4 + i * 4, true) >>> 0);
      return { ctrl: ctrl >>> 0, enabled: !!(ctrl & 1), used: comps.filter(c => c !== 0).length, comps };
    },
    /** 泄漏 = 硬件比较器占用有没有超出"用户断点"该占的个数 */
    async leak(){
      const f = await this.fpb();
      const bps = d.session.bpList().length;
      return { bps, used: f.used, extra: f.used - bps, ctrl: '0x' + f.ctrl.toString(16) };
    },
  };
  return true;`);

// 源码目录用**真文件**喂进去（CDP 给 <input webkitdirectory> 设文件，等价于用户点"选择源码目录"）
{
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#d-src-dir' });
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [SRCDIR] });
  await sleep(500);
}

sec('== 0. 前置：ELF + 源码目录 + 连接探针 ==');
const elfInfo = await cdp.json(`(async () => {
    const d = window.__tools.dbg;
    const r = await fetch(${JSON.stringify(ELF)} + '?t=' + Date.now());
    const st = d.loadElfBuffer(await r.arrayBuffer(), 'fw.elf');
    if (!st) return { err: document.getElementById('d-out').textContent.slice(-300) };
    return { summary: st.summary(), lines: st.lines ? st.lines.summary() : null, src: d.src.summary(), srcReady: d.src.ready };
  })()`);
if (elfInfo.err) throw new Error('ELF 载入失败：' + elfInfo.err);
log('   ' + elfInfo.summary);
log('   ' + elfInfo.lines);
log('   ' + elfInfo.src);
ok(/行号表/.test(elfInfo.lines || ''), 'ELF 带行号表：' + elfInfo.lines);
ok(elfInfo.srcReady, '源码目录已喂进页面（真文件）：' + elfInfo.src);
ok(CALL_LINE > 0 && CALL2_LINE > 0, `靶子源码行号定位成功（调用在第 ${CALL_LINE} / ${CALL2_LINE} 行）`);

// RTT 泵会跟调试抢 SWD；"运行中也刷新"也会插队 —— 先关掉
await cdp.eval(`const off = (id) => { const el = document.getElementById(id); if (el && el.checked){ el.checked = false; el.dispatchEvent(new Event('change')); } };
  off('d-rtt-on'); off('d-watch-live'); document.getElementById('d-rtt-stop')?.click();
  await new Promise(r => setTimeout(r, 300)); return true;`);

await cdp.eval(`const be = document.getElementById('d-backend'); be.value = 'webusb'; be.dispatchEvent(new Event('change')); return true;`);
const connP = cdp.eval(`await window.__tools.dbg.connect(); return true;`, true);
await cdp.settle(DEV_RE, 'window.__tools.dbg.session.connected', 12000).catch(() => {});
await connP.catch(e => log('   连接异常：' + e.message));
await cdp.eval(`await window.__tools.dbg.session.halt(); await window.__tools.dbg.afterStop(); return true;`);
const env = await cdp.json(`(async () => {
    const d = window.__tools.dbg, S = window.__S;
    return { cap: d.session.caps, name: d.session.name, idcode: '0x' + ((d.session.idcode ?? 0) >>> 0).toString(16),
             vec: [...await d.session.memRead(0x08000000, 8)].map(x => x.toString(16).padStart(2, '0')).join(' '),
             resetSym: d.sym.find('Reset_Handler')?.addr ?? null, leak: await S.leak(), snap: S.snap() };
  })()`);
const VEC_BYTES = env.vec.split(' ').map(x => parseInt(x, 16));
const RESET_VEC = ((VEC_BYTES[4] | (VEC_BYTES[5] << 8) | (VEC_BYTES[6] << 16) | (VEC_BYTES[7] << 24)) >>> 0) & 0xfffffffe;
log(`   探针 ${env.name} · IDCODE ${env.idcode} · FPB ${env.cap.numCode} 个 rev${env.cap.rev}`);
log(`   复位向量 = ${hex(RESET_VEC)}（Reset_Handler 符号 = ${hex(env.resetSym)}）· 起点 PC=${hex(env.snap.pc)} ${env.snap.name}`);
ok(env.snap.connected && env.snap.halted, '连上真探针并停住目标');
ok(env.cap.numCode >= 4, `FPB 比较器够用（${env.cap.numCode} 个）`);
ok(env.leak.used === 0 && env.leak.bps === 0, '干净起点：没有任何断点占着比较器', JSON.stringify(env.leak));

/** 采集到的"标准答案"，用来跟 gdb 对照 */
const oracle = { elf: ELF, linear: [], bpAddr: {}, steps: {}, struct: {}, resetVec: RESET_VEC };

// ==================================================================== 1
sec('== 1. 断点：文件:行 / 符号 / static / 偏移 / 多断点 / ISR ==');
{
  const specs = await cdp.json(`(async () => {
      const d = window.__tools.dbg, out = {};
      for (const fn of ['engine_linear', 'engine_deep_chain', 'engine_rec_fib', 'engine_dispatch', 'model_update', 'deep_l5', 'is_even']){
        const f = d.sym.find(fn);
        const at = f ? d.sym.at(f.addr) : null;
        out[fn] = f ? { addr: f.addr >>> 0, file: at?.file || '', line: at?.line || 0 } : null;
      }
      return out;
    })()`);
  log('   符号表（函数 → 首行）：' + Object.entries(specs).map(([k, v]) => `${k}=${hex(v?.addr)} ${String(v?.file).split('/').pop()}:${v?.line}`).join('  '));
  ok(Object.values(specs).every(Boolean), '关键函数都在符号表里（含 static 的 deep_l5 / is_even）');

  for (const fn of ['engine_linear', 'model_update']){
    const f = specs[fn];
    const spec = `${String(f.file).split('/').pop()}:${f.line}`;
    const r = await cdp.json(`(async () => {
        const S = window.__S, d = window.__tools.dbg;
        await d.session.bpClear();
        const c = await S.cmd('b ' + ${JSON.stringify(spec)});
        const bps = d.session.bpList();
        const out = { out: c.out, addr: bps[0]?.addr ?? null };
        await d.session.bpClear();
        return out;
      })()`);
    oracle.bpAddr[spec] = r.addr;
    ok(r.addr === f.addr, `b ${spec} 落到 ${hex(r.addr)}（与 b ${fn} 的 ${hex(f.addr)} 一致）`, JSON.stringify(r.out));
  }

  const st1 = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b deep_l5');
      const a = d.session.bpList()[0]?.addr ?? null;
      await d.session.bpClear();
      await S.cmd('b engine_linear+8');
      const b = d.session.bpList()[0]?.addr ?? null;
      await d.session.bpClear();
      const inline = (await S.cmd('b engine_inline_double')).text;
      const badline = (await S.cmd('b engine.c:99999')).text;
      return { a, b, inline, badline };
    })()`);
  ok(st1.a === specs.deep_l5.addr, `b deep_l5（static 函数）能下：${hex(st1.a)}`);
  ok(st1.b === (specs.engine_linear.addr + 8), `b engine_linear+8 支持偏移：${hex(st1.b)}`);
  ok(/认不出地址|找不到/.test(st1.inline), '内联函数下不到断点时会明说：' + st1.inline);
  ok(/只有第 \d+~\d+ 行/.test(st1.badline), '行号超出文件范围时说人话：' + st1.badline);

  // 多断点：挑**每轮只被调用一次**的四个函数（engine_rec_fib 是递归的，会连中好几次，不适合当"每轮一次"用）
  const multi = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      for (const f of ['engine_linear', 'engine_deep_chain', 'engine_dispatch', 'model_update']) await S.cmd('b ' + f);
      const seen = [];
      let lastHalted = true;
      for (let i = 0; i < 24; i++){
        const s = await S.go(4000);
        lastHalted = s.halted;
        if (!s.halted) break;
        seen.push(d.sym.funcAt(s.pc)?.name || '?');
        if (new Set(seen).size >= 4) break;
      }
      const leak = await S.leak();
      await d.session.bpClear();
      const clean = await S.leak();
      return { seen, lastHalted, leak, clean };
    })()`);
  ok(new Set(multi.seen).size === 4, '4 个断点同时挂着，每一轮都轮到：' + multi.seen.join(' → '));
  ok(multi.leak.extra === 0, '4 个断点占的就是 4 个比较器（没有多占）', JSON.stringify(multi.leak));
  ok(multi.clean.used === 0 && multi.clean.bps === 0, '清空断点后比较器全部释放', JSON.stringify(multi.clean));

  // 中断里下断点（SysTick 10 kHz → 继续就立刻命中）
  const isr = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b SysTick_Handler');
      const t0 = Date.now();
      const s = await S.go(4000);
      const ms = Date.now() - t0;
      await d.session.bpClear();
      return { halted: s.halted, pc: s.pc, nm: s.name, ms };
    })()`);
  ok(isr.halted && /SysTick_Handler/.test(isr.nm), `中断里的断点命中（${hex(isr.pc)} ${isr.nm}，用时 ${isr.ms}ms）`);

  // 同一个断点连续命中 5 次
  const loop = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b is_even');
      const want = d.sym.find('is_even').addr >>> 0;
      const addrs = [];
      for (let i = 0; i < 5; i++){ const s = await S.go(4000); if (!s.halted) break; addrs.push(s.pc); }
      await d.session.bpClear();
      return { addrs, want };
    })()`);
  ok(loop.addrs.length === 5 && loop.addrs.every(a => a === loop.want),
    `同一个断点连续命中 5 次都在 ${hex(loop.want)}（is_even）`, JSON.stringify(loop.addrs.map(hex)));
}

// ==================================================================== 2
sec('== 2. 代码同步：停下时 PC → 源码位置必须自洽（跨文件）==');
{
  const sync = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const out = [];
      await d.session.bpClear();
      for (const f of ['engine_linear', 'model_bitfield_touch', 'engine_branchy']){
        await S.cmd('b ' + f);
        const s = await S.go(4000);
        const at = d.sym.at(s.pc);
        out.push({ fn: f, halted: s.halted, pc: s.pc, name: s.name, pos: s.pos, curLine: s.curLine, file: s.file,
                   wantLine: at?.line, wantFile: String(at?.file || '').split('/').pop() });
        await d.session.bpClear();
      }
      // main 的第一条指令在"复位之后"才会被走到 —— 先复位并停（停在复位向量），再继续
      await S.cmd('reset halt');
      await S.cmd('b main');
      const sm = await S.go(4000);
      const atm = d.sym.at(sm.pc);
      out.push({ fn: 'main', halted: sm.halted, pc: sm.pc, name: sm.name, pos: sm.pos, curLine: sm.curLine, file: sm.file,
                 wantLine: atm?.line, wantFile: String(atm?.file || '').split('/').pop() });
      await d.session.bpClear();
      // 指令级单步：行号必须逐步自洽
      await S.cmd('b engine_linear');
      await S.go(4000);
      const seq = [];
      for (let i = 0; i < 6; i++){
        const s = await S.step('si');
        const at = d.sym.at(s.pc);
        seq.push({ pc: s.pc, line: at?.line ?? null, file: String(at?.file || '').split('/').pop(), curLine: s.curLine });
      }
      await d.session.bpClear();
      return { out, seq };
    })()`);
  for (const r of sync.out){
    ok(r.halted && r.curLine === r.wantLine && r.wantLine > 0,
      `停到 ${r.fn}：源码视图高亮第 ${r.curLine} 行 == 行号表的第 ${r.wantLine} 行（${r.wantFile}:${r.wantLine}）`,
      JSON.stringify({ pc: hex(r.pc), pos: r.pos, file: r.file, cur: r.curLine }));
    ok(r.name.includes(r.fn), `停止位置显示函数名 ${r.fn}：${r.name}`);
  }
  ok(sync.seq.length === 6 && sync.seq.every(x => x.curLine === x.line && x.line > 0),
    '指令级单步时每一步的"源码高亮 == 行号表"：' + sync.seq.map(x => `${x.file}:${x.line}`).join(' '));
  ok(sync.seq.every((x, i) => i === 0 || x.pc > sync.seq[i - 1].pc),
    'si 的 PC 单调前进（' + sync.seq.map(x => hex(x.pc)).join(' → ') + '）');
}

// ==================================================================== 3
sec('== 3. 单步：n / si / fin（源码级，含间接调用与 5 层爬栈）==');
{
  const lin = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_linear');
      const s0 = await S.go(4000);
      const seq = [{ pc: s0.pc, line: d.sym.at(s0.pc)?.line ?? null, halted: s0.halted }];
      for (let i = 0; i < 19; i++){
        const s = await S.step('n');
        seq.push({ pc: s.pc, line: d.sym.at(s.pc)?.line ?? null, halted: s.halted });
      }
      const leak = await S.leak();
      await d.session.bpClear();
      return { seq, leak };
    })()`);
  oracle.linear = lin.seq;
  log('   单步序列：' + lin.seq.map(x => `${hex(x.pc)}(L${x.line})`).join(' → '));
  ok(lin.seq.length === 20 && lin.seq.every(x => x.halted), '拿到 20 步的落点序列（每一步都真的停住了）');
  ok(lin.seq.every((x, i) => i === 0 || x.pc !== lin.seq[i - 1].pc), '每一步 PC 都变了（不会"点了没反应"）');
  ok(lin.seq.every(x => x.line > 0), '每一步都有源码行号');
  ok(lin.leak.extra === 0, `20 次单步后**只**占着用户断点那 1 个比较器（直读 FP_COMP：${lin.leak.used} 个 / 断点 ${lin.leak.bps} 个）`, JSON.stringify(lin.leak));

  // n 跳过调用：从调用那一句按 n，必须落到"下一句"而不是被调函数里
  const over = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const leaf = d.sym.find('engine_leaf').addr >>> 0;
      await d.session.bpClear();
      await S.cmd('b ' + ${JSON.stringify('engine.c')} + ':' + ${CALL_LINE});
      const s0 = await S.go(4000);
      const line0 = d.sym.at(s0.pc)?.line ?? 0;
      const s1 = await S.step('n');
      const inLeaf = (d.sym.funcAt(s1.pc)?.name || '') === 'engine_leaf';
      await d.session.bpClear();
      return { line0, s0pc: s0.pc, pc: s1.pc, halted: s1.halted, inLeaf, line: d.sym.at(s1.pc)?.line ?? 0, leaf, text: s1.text };
    })()`);
  ok(over.line0 === CALL_LINE, `断在调用那一句（engine.c:${over.line0}）`);
  ok(over.halted && !over.inLeaf && over.pc !== over.s0pc, `n（跳过）越过调用、没进 engine_leaf：${hex(over.s0pc)} → ${hex(over.pc)}（engine.c:${over.line}）`, JSON.stringify(over));

  // si 进入调用：停在调用那一句，连续 si 直到进 engine_leaf
  const into = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const leaf = d.sym.find('engine_leaf').addr >>> 0;
      await d.session.bpClear();
      await S.cmd('b engine.c:' + ${CALL_LINE});
      await S.go(4000);
      let hit = null, tries = 0, seq = [];
      for (let i = 0; i < 8 && !hit; i++){
        const s = await S.step('si'); tries++;
        seq.push('0x' + s.pc.toString(16));
        if ((d.sym.funcAt(s.pc)?.name || '') === 'engine_leaf') hit = s.pc;
      }
      const leak = await S.leak();
      await d.session.bpClear();
      return { hit, tries, seq, leaf, leak, bpsAfter: d.session.bpList().length };
    })()`);
  oracle.steps.intoLeaf = into.hit;
  ok(into.hit === into.leaf, `si 从调用点进入 engine_leaf（第 ${into.tries} 次 si 停在 ${hex(into.hit)}，路径 ${into.seq.join(' → ')}）`, JSON.stringify(into));
  ok(into.leak.extra === 0, 'si 之后比较器也没多占（用户断点 1 个 → 硬件占 1 个）', JSON.stringify(into.leak));

  // fin 逐层爬栈：deep_l5 → deep_l4 → l3 → l2 → deep_l1 → engine_deep_chain（中间有 LR 被覆盖的非叶子层）
  const fin = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const hx = v => '0x' + ((v ?? 0) >>> 0).toString(16);
      await d.session.bpClear();
      await S.cmd('b deep_l5');
      const s0 = await S.go(4000);
      const chain = [d.sym.funcAt(s0.pc)?.name || '?'];
      const out = [];
      for (let i = 0; i < 5; i++){
        const lr = (await d.session.readReg('LR')) >>> 0;
        const sp = (await d.session.readReg('SP')) >>> 0;
        const s = await S.step('fin', 8000);
        chain.push(d.sym.funcAt(s.pc)?.name || '?');
        out.push({ lr: hx(lr), sp: hx(sp), pc: hx(s.pc), name: s.name, halted: s.halted, msg: s.text.slice(0, 120) });
      }
      const leak = await S.leak();
      await d.session.bpClear();
      const clean = await S.leak();
      return { chain, out, leak, clean };
    })()`);
  log('   fin 爬栈：' + fin.chain.join(' → '));
  const wantChain = ['deep_l5', 'engine_deep_l4', 'engine_deep_l3', 'engine_deep_l2', 'deep_l1', 'engine_deep_chain'];
  ok(JSON.stringify(fin.chain) === JSON.stringify(wantChain), '连续 5 次「跳出」逐层爬回调用者：' + fin.chain.join(' → '), JSON.stringify(fin.out));
  ok(fin.out.every(o => o.halted), '每一步都停住了（不是超时后的残留状态）');
  ok(fin.leak.extra === 0 && fin.clean.used === 0, 'fin 之后比较器收干净', JSON.stringify({ leak: fin.leak, clean: fin.clean }));

  // 函数指针（BLX Rn）也要能进去
  const ind = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_dispatch');
      const s0 = await S.go(4000);
      let hit = null, tries = 0, seq = [];
      for (let i = 0; i < 10 && !hit; i++){
        const s = await S.step('si', 5000); tries++;
        const nm = d.sym.funcAt(s.pc)?.name || '';
        seq.push(nm + '@0x' + s.pc.toString(16));
        if (/^fn_(add|xor|mul|rol)$/.test(nm)) hit = { pc: s.pc, nm };
      }
      const leak = await S.leak();
      await d.session.bpClear();
      return { started: s0.halted, hit, tries, seq, leak };
    })()`);
  ok(ind.started && !!ind.hit, `si 能跟进**函数指针**调用（第 ${ind.tries} 次停在 ${ind.hit?.nm ?? '—'}）：${ind.seq.join(' → ')}`, JSON.stringify(ind));
  ok(ind.leak.extra === 0, '间接调用单步后比较器也收干净');

  // 递归内部：n 与 fin 都能正常走
  const rec = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_rec_fib');
      await S.go(4000);
      const s1 = await S.step('n');
      const s2 = await S.step('fin', 8000);
      const leak = await S.leak();
      await d.session.bpClear();
      return { n: s1.name, fin: s2.name, halted: s2.halted, leak };
    })()`);
  ok(rec.halted && /engine_rec_fib/.test(rec.fin), `递归函数里 n/fin 都能回到递归体（n→${rec.n}，fin→${rec.fin}）`, JSON.stringify(rec));
  ok(rec.leak.extra === 0, '递归里单步后比较器也收干净');
}

// ==================================================================== 4
sec('== 4. 复位重跑：必须停在复位向量 → 断点仍然有效 → 再命中（连续 3 轮）==');
{
  const rst = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const rounds = [];
      await d.session.bpClear();
      await S.cmd('b engine_linear');
      const want = d.sym.find('engine_linear').addr >>> 0;
      for (let i = 0; i < 3; i++){
        const r = await S.cmd('reset halt');
        const s0 = S.snap();
        const fpb = await S.fpb();
        const s1 = await S.go(4000);
        rounds.push({ resetPc: s0.pc, resetName: s0.name, halted: s0.halted, bpPage: s0.bps, compUsed: fpb.used,
                      hit: s1.halted, hitPc: s1.pc, hitName: s1.name, out: r.text.slice(0, 100) });
        if (!s1.halted) break;
      }
      await d.session.bpClear();
      return { rounds, want };
    })()`);
  for (const [i, r] of rst.rounds.entries()){
    log(`   第 ${i + 1} 轮：复位后 PC=${hex(r.resetPc)} ${r.resetName}（比较器 ${r.compUsed}）→ 继续命中=${r.hit} ${hex(r.hitPc)} ${r.hitName}`);
  }
  ok(rst.rounds.length === 3, '复位 3 轮都跑完了');
  ok(rst.rounds.every(r => r.resetPc === RESET_VEC),
    `「复位并停」停在**复位向量**上（${hex(RESET_VEC)} = Reset_Handler）：` + rst.rounds.map(r => hex(r.resetPc)).join(' , '));
  ok(rst.rounds.every(r => r.hit && r.hitPc === rst.want),
    '复位之后断点仍然有效、继续就能命中：' + rst.rounds.map(r => `${hex(r.hitPc)}`).join(' , '));
}

// ==================================================================== 5
sec('== 5. 内存 / 监视：结构体树、位域、复合路径 ==');
{
  const mp = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b model_update');
      await S.go(4000);
      const A = await S.cmd('p g_model');
      const B = await S.cmd('p g_model.flags');
      const C = await S.cmd('p g_model.flags.bits.level');
      const D = await S.cmd('p g_model.flags.sbits.bias');
      const E = await S.cmd('p g_model.nodes[1]');
      const F = await S.cmd('p g_model.nodes[1].cell');
      const G = await S.cmd('p g_model.nodes[1].cell.scale');
      const H = await S.cmd('p g_model.word.halves.hi');
      const I = await S.cmd('p g_model.blob');
      const J = await S.cmd('p g_model.tag');
      const K = await S.cmd('p g_model.label');
      const L = await S.cmd('p g_model.head');
      const M = await S.cmd('p g_model.nodes[9]');
      const N = await S.cmd('p g_model.nosuchmember');
      const O = await S.cmd('p g_model_plain');
      const P = await S.cmd('p g_model_const');
      const f = d.sym.typeOf('g_model.flags');
      const raw = await d.session.memRead(f.addr, 20);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
      const w0 = dv.getUint32(0, true) >>> 0, w1 = dv.getUint32(16, true) >>> 0;
      const check = { w0, w1, addr: f.addr,
        bits: { on: w0 & 1, level: (w0 >>> 1) & 7, mode: (w0 >>> 4) & 3, parity: (w0 >>> 6) & 1, rev: (w0 >>> 7) & 0x1ff, spare: (w0 >>> 16) & 0xffff },
        sb: { bias: (w1 << 26) >> 26, tag: (w1 >>> 6) & 0x3ff, rest: (w1 >>> 16) & 0xffff } };
      await d.session.bpClear();
      return { A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, check };
    })()`);
  const first = a => (a.out || [])[0] || '';
  log('   p g_model            : ' + first(mp.A));
  log('   p g_model.flags      : ' + first(mp.B));
  log('   p <位域>             : ' + first(mp.C));
  log('   p <有符号位域>       : ' + first(mp.D));
  log('   p nodes[1].cell.scale: ' + first(mp.G));
  ok(/struct/.test(first(mp.A)) && mp.A.out.length > 20, `p g_model 打出结构体树（${mp.A.out.length} 行）`);
  ok(/struct/.test(first(mp.B)) && mp.B.out.some(l => /on : 1/.test(l)), 'p g_model.flags：嵌套结构体带位域行');
  ok(/位域\[bit 1 · 3 位\]/.test(first(mp.C)), 'p <位域>按位取（不是把整个 u32 打出来）：' + first(mp.C));
  ok(/有符号/.test(first(mp.D)), '有符号位域明确标出来：' + first(mp.D));
  ok(/node_s|struct/.test(first(mp.E)), 'p g_model.nodes[1]（数组元素）✓：' + first(mp.E));
  ok(/cell_t|struct/.test(first(mp.F)), 'p g_model.nodes[1].cell（数组元素里的结构体）✓：' + first(mp.F));
  ok(/f64|double/.test(first(mp.G)), 'p g_model.nodes[1].cell.scale（三层路径）✓：' + first(mp.G));
  ok(/u16|unsigned/.test(first(mp.H)), 'p g_model.word.halves.hi（联合体里的成员）✓：' + first(mp.H));
  ok(/array/.test(first(mp.I)) && mp.I.out.some(l => /^\[7\]/.test(l)), 'p g_model.blob（字节数组 8 项）' + mp.I.out.length + ' 行');
  ok(/01234567/.test(mp.J.text), 'char[8] 当字符串显示（没有 NUL 也不越界）：' + first(mp.J));
  ok(!/找不到/.test(first(mp.K)) && mp.K.out.length >= 1, 'p g_model.label（指针成员）能打：' + first(mp.K));
  ok(!/找不到/.test(first(mp.L)) && mp.L.out.length >= 1, 'p g_model.head（结构体指针）能打：' + first(mp.L));
  ok(/越界/.test(first(mp.M)), '下标越界如实报错：' + first(mp.M));
  ok(/没有成员/.test(first(mp.N)), '成员名写错如实报错：' + first(mp.N));
  ok(/struct/.test(first(mp.O)) && mp.O.out.length > 20, 'p g_model_plain（非 volatile 对照）同样能展开');
  ok(/struct/.test(first(mp.P)) && mp.P.out.length > 20, 'p g_model_const（const/flash 里的对象）同样能展开：' + first(mp.P));

  // 位域与影子字逐位对账（树里的位域行 vs 影子字的手工移位）
  const rawTree = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const t = d.sym.typeOf('g_model.flags');
      const raw = await d.session.memRead(t.addr, 20);
      const W = await import('/app/dbg/watch.js');
      return W.treeRows({ type: t.type, label: 'flags' }, raw).map(r => ({ n: r.name, t: r.text, bf: !!r.bitfield }));
    })()`);
  const got = {};
  for (const r of rawTree) if (r.bf) got[String(r.n).split(' ')[0]] = r.t;
  const cf = mp.check;
  const want = { ...cf.bits, ...cf.sb };
  const mism = [];
  for (const [k, v] of Object.entries(want)){
    const g = got[k];
    const gv = g != null ? Number(String(g).split(' ')[0]) : null;
    if (gv !== v) mism.push(`${k}: 树=${gv} 影子字=${v}`);
  }
  ok(mism.length === 0, `位域与影子字逐位对账（word=0x${cf.w0.toString(16)} / word2=0x${cf.w1.toString(16)}，${Object.keys(want).length} 个字段）`, mism.join('；'));
  oracle.struct = { w0: cf.w0, w1: cf.w1, bits: cf.bits, sb: cf.sb };

  // 监视窗口：结构体树展开 + 复合路径 + 写错时的表现
  const watch = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await S.cmd('wd all');
      await S.cmd('w g_model');
      await S.cmd('w g_model.flags.bits.level');
      await S.cmd('w g_model.nodes[2].cell.scale');
      await S.cmd('w g_model.nope');
      const items = d.watch.items.map(it => ({ e: it.expr, err: it.error || null, kind: it.kind, v: it.value?.text ?? null }));
      document.querySelector('#d-watch-list button.exp')?.click();
      await new Promise(r => setTimeout(r, 400));
      const rows = [...document.querySelectorAll('#d-watch-list .wkid')].map(e => e.textContent.trim());
      await S.cmd('wd all');
      return { items, rows: rows.slice(0, 40), rowCount: rows.length };
    })()`);
  log('   w g_model → ' + JSON.stringify(watch.items[0]));
  ok(watch.items[0] && !watch.items[0].err && watch.items[0].kind === 'struct', '监视加结构体项：' + JSON.stringify(watch.items[0]));
  ok(watch.rowCount > 20, `展开后画出成员树（${watch.rowCount} 行）`);
  ok(watch.rows.some(r => /on\s*:\s*1/.test(r)), '树里有位域行：' + (watch.rows.find(r => /on\s*:\s*1/.test(r)) || ''));
  ok(watch.items[1] && !watch.items[1].err, '监视复合路径（位域）✓：' + JSON.stringify(watch.items[1]));
  ok(watch.items[2] && !watch.items[2].err, '监视复合路径（数组元素成员）✓：' + JSON.stringify(watch.items[2]));
  ok(watch.items[3] && watch.items[3].err, '监视里写错的名字会标红并说明：' + JSON.stringify(watch.items[3]));

  // 内存面板 + 一条会 FAULT 的地址：报错要人话，链路要能自愈
  const fault = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      let msg = '';
      try { await d.session.memRead(0x20020000, 16); } catch (e){ msg = String(e?.message || e); }
      let after = null;
      try { after = [...await d.session.memRead(0x08000000, 8)].map(x => x.toString(16)).join(' '); } catch (e){ after = 'ERR ' + e.message; }
      return { msg, after, heals: d.session.probe.faultHeals || 0 };
    })()`);
  ok(/总线 FAULT/.test(fault.msg) && /不用重连/.test(fault.msg), '读不到的总线地址给出人话错误：' + fault.msg.slice(0, 80));
  ok(/^0 /.test(fault.after) && fault.heals >= 1, `FAULT 之后链路自愈、还能继续读 flash（自愈 ${fault.heals} 次）：${fault.after}`);
}

// ==================================================================== 6
sec('== 6. 压力：连续 60 次「停 — 走 — 停」+ 比较器泄漏 ==');
{
  const stress = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_branchy');
      const names = [], lines = [], bad = [];
      let maxExtra = 0, misses = 0;
      for (let i = 0; i < 60; i++){
        const s = await S.go(3000);
        if (!s.halted){ misses++; continue; }
        names.push(d.sym.funcAt(s.pc)?.name || '?');
        lines.push(d.sym.at(s.pc)?.line ?? 0);
        if (i % 10 === 0){
          const lk = await S.leak();
          maxExtra = Math.max(maxExtra, lk.extra);
          if (lk.extra !== 0 || lk.bps !== 1) bad.push('第 ' + i + ' 轮：' + JSON.stringify(lk));
        }
      }
      const final = await S.leak();
      await d.session.bpClear();
      const clean = await S.leak();
      return { n: names.length, misses, names: [...new Set(names)], lines: [...new Set(lines)], bad, maxExtra, final, clean };
    })()`);
  log(`   60 轮：停下来的函数集合 = ${stress.names.join(',')} · 行号集合 = ${stress.lines.join(',')}`);
  ok(stress.n === 60 && stress.misses === 0, `连续 60 轮都停下来了（实际 ${stress.n}，漏 ${stress.misses}）`, JSON.stringify(stress.bad));
  ok(stress.names.length === 1 && stress.names[0] === 'engine_branchy', '60 轮都停在同一个断点上');
  ok(stress.bad.length === 0 && stress.maxExtra === 0, '过程中比较器占用始终等于"用户断点个数"（没有临时断点残留）', JSON.stringify(stress.bad));
  ok(stress.clean.used === 0, `压完清空断点，硬件比较器回到 0（峰值多占 ${stress.maxExtra}）`);
}

// ==================================================================== 7
sec('== 7. 收尾 + 与 gdb 对照 ==');
{
  const errs = await cdp.eval('return window.__tools.errors || [];');
  ok(Array.isArray(errs) && errs.length === 0, '整轮没有一个页面未捕获错误', JSON.stringify(errs).slice(0, 300));

  if (existsSync(ORACLE)){
    const g = JSON.parse(readFileSync(ORACLE, 'utf8'));
    log('   载入 gdb 对照：' + ORACLE + '（' + (g.tool || 'arm-none-eabi-gdb') + '）');
    /**
     * 逐地址比对。两处**口径差异**要先说清楚（不是我们的 bug，也不是 gdb 的）：
     *   · 页面序列的第 0 条是"刚在 engine_linear 上停下"，gdb 那边是 20 次 `next`（没有这一条）→ 对齐时要错开一位；
     *   · 我们的 `n` 是"**地址序**的下一条语句"，gdb 的 `next` 是"**行号变化**才停" +
     *     会跳过内联函数的收尾。所以只在**同一个函数体内**逐条比；一旦步出函数
     *     （这里 `stage_run` 被内联进 main 了），两者落点可以不同 —— 那属于口径差异，如实说明。
     */
    const pageSeq = oracle.linear.slice(1).map(x => x.pc);
    const gseq = (g.linear || []).map(x => x.pc);
    const fnStart = RESET_VEC === 0 ? 0 : (await cdp.json(`(async () => { const d = window.__tools.dbg; const f = d.sym.find('engine_linear'); return { s: f.addr >>> 0, e: (f.addr + f.size) >>> 0 }; })()`));
    const inFn = a => a >= fnStart.s && a < fnStart.e;
    const diff = [];
    let n = 0;
    for (let i = 0; i < Math.min(pageSeq.length, gseq.length); i++){
      if (!inFn(pageSeq[i]) || !inFn(gseq[i])) break;         // 出了函数不再比（口径不同）
      n++;
      if (pageSeq[i] !== gseq[i]) diff.push(`第 ${i} 步：页面 ${hex(pageSeq[i])} ≠ gdb ${hex(gseq[i])}`);
    }
    log('   页面：' + pageSeq.map(hex).join(' → '));
    log('   gdb ：' + gseq.map(hex).join(' → '));
    ok(n >= 15, `函数体内可比对的单步序列长度 ${n}（页面 ${pageSeq.length} / gdb ${gseq.length}）`);
    ok(diff.length === 0, `engine_linear 内的单步落点与 gdb **逐步一致**（${n} 步，含两次函数调用）`, diff.slice(0, 4).join('；'));
    const pOut = pageSeq.find(a => !inFn(a)), gOut = gseq.find(a => !inFn(a));
    if (pOut != null && gOut != null && pOut !== gOut){
      log(`   （步出函数之后落点不同：页面 ${hex(pOut)} / gdb ${hex(gOut)} —— 调用者 stage_run 被内联进 main，`
        + '我们的"下一条语句"按地址序、gdb 按行号变化，口径不同，两者都在 main 里）');
    }
    const bd = [];
    for (const [spec, addr] of Object.entries(g.bpAddr || {})){
      if (oracle.bpAddr[spec] === undefined) continue;
      if (oracle.bpAddr[spec] !== addr) bd.push(`${spec}: 页面 ${hex(oracle.bpAddr[spec])} ≠ gdb ${hex(addr)}`);
    }
    ok(bd.length === 0, `「文件:行」断点落点与 gdb 一致（比了 ${Object.keys(oracle.bpAddr).length} 个）`, bd.join('；'));
    ok(g.resetVec == null || g.resetVec === oracle.resetVec, `复位向量一致：页面 ${hex(oracle.resetVec)} / gdb ${hex(g.resetVec)}`);
    /**
     * 位域/结构体：两次会话停在不同轮次，**原始数值当然不同**，所以不比数值 ——
     * 比的是"gdb 独立读出来的位域 == 页面那套位移假设"（在 oracle 脚本里逐字段核对过）。
     */
    ok(g.struct?.layoutOk === true, 'gdb 独立核对：位域排布与页面解码假设一致（word/spare/bias…逐字段）',
      JSON.stringify(g.struct?.diff || []));
  } else {
    log('   （没有 ' + ORACLE + '，跳过 gdb 对照 —— 先跑 node tmp/dbg-gdb-oracle.mjs）');
  }

  await cdp.eval(`await window.__tools.dbg.session.bpClear(); await window.__tools.dbg.disconnect(); return true;`);
  writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), elf: ELF, pass, fail, failures, oracle }, null, 1));
  log('   测量结果已写入 ' + JSON_OUT);
}

log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`);
if (failures.length){ log('失败项：'); for (const f of failures) log('  · ' + f); }
cdp.close();
process.exit(fail ? 1 : 0);
