/**
 * 纯 Node 自测：调试页的**逻辑层**（不需要浏览器、不需要硬件）。
 *
 *   node tools/selftest/dbg-core.test.mjs      （等价：make test-dbg）
 *
 * 覆盖四块，都是"错了会静默给错答案"的地方：
 *   1) 位域与编码：xPSR 的拆位、CFBP 的字节顺序（PRIMASK 在最低字节）、FPB 比较器的编码
 *      —— 这几个数字查过 OpenOCD/pyOCD 的实现，钉在这里防止以后被"顺手改回去"；
 *   2) 输入解析：md/mw 的地址与字节串（连续十六进制、奇数长度、越界值都必须报错而不是猜）；
 *   3) 符号表：找函数/变量、`名字+偏移` 解析、PC 落点；
 *   4) **整条会话链**：用 app/dbg/mock.js 那个假目标跑
 *      「连接 → 读寄存器 → 写内存 → 下断点 → 继续 → 命中断点 → 再继续（跨过断点）」，
 *      —— 这是页面上的按钮真正会走的那条路径，只是把 DOM 换成了断言。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const url = p => 'file://' + join(here, '..', '..', 'app', p).replace(/\\/g, '/');
const F = await import(url('dbg/fmt.js'));
const R = await import(url('dbg/regs.js'));
const B = await import(url('dbg/bp.js'));
const SY = await import(url('dbg/symbols.js'));
const C = await import(url('dbg/cmd.js'));
const S = await import(url('dbg/session.js'));
const W = await import(url('dbg/watch.js'));
const CP = await import(url('dbg/complete.js'));
const LN = await import(url('elf/lines.js'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==================================================================== 1
console.log('== 1. 数字与字节串的解析（命令行的地基）==');
{
  ok(F.parseNum('0x20000000') === 0x20000000, 'parseNum 认 0x 前缀');
  ok(F.parseNum('2000h') === 0x2000, 'parseNum 认尾缀 h');
  ok(F.parseNum('0b1010') === 10, 'parseNum 认二进制');
  ok(F.parseNum('64') === 64, 'parseNum 十进制（不是十六进制！）');
  ok(F.parseNum('1_000') === 1000, 'parseNum 忽略下划线分隔');
  ok(F.parseNum('0xZZ') === null && F.parseNum('') === null && F.parseNum('abc') === null, 'parseNum 认不出就回 null（不静默当 0）');

  const a = F.parseBytes('01 02 ff');
  ok(a.length === 3 && a[0] === 1 && a[2] === 0xff, 'parseBytes 空格分隔');
  ok(F.parseBytes('0x01,0x02').length === 2, 'parseBytes 逗号 + 0x 前缀');
  ok(F.parseBytes('0102ff').length === 3, 'parseBytes 连续写法（偶数长度）');
  let threw = '';
  try { F.parseBytes('0102f'); } catch (e){ threw = e.message; }
  ok(/偶数/.test(threw), 'parseBytes 奇数长度连续写法必须报错（不能猜）', threw);
  threw = '';
  try { F.parseBytes('01 1ff'); } catch (e){ threw = e.message; }
  ok(/不是一个字节/.test(threw), 'parseBytes 超过 0xff 必须报错', threw);

  const dump = F.hexdump(Uint8Array.from([0x48, 0x69, 0x21, 0x00]), 0x20000000);
  ok(dump.length === 1 && dump[0].startsWith('0x20000000  48 69 21 00'), 'hexdump 首行地址与字节', dump[0]);
  ok(dump[0].includes('|Hi!.') && dump[0].includes('|'), 'hexdump 右侧 ASCII 列', dump[0]);
  const two = F.hexdump(new Uint8Array(20), 0x1000);
  ok(two.length === 2 && two[1].includes('0x00001010'), 'hexdump 按 16 字节分行且第二行地址正确', two[1]);
  ok(F.readLE(Uint8Array.from([0x11, 0x22, 0x33, 0x44])) === 0x44332211, 'readLE 小端');
}

// ==================================================================== 2
console.log('== 2. 寄存器位域（xPSR / CFBP）==');
{
  ok(R.regInfo('R0').sel === 0 && R.regInfo('r15').name === 'PC', '寄存器名大小写不敏感、r15=PC');
  ok(R.regInfo('SP').sel === 0x0d && R.regInfo('psp').sel === 0x12, 'SP/PSP 的 REGSEL 正确');
  ok(R.regInfo('nope') === null, '不认识的寄存器回 null');

  const x = R.decodeXpsr(0x41000000);        // Z(30) + T(24)
  ok(x.z === 1 && x.n === 0 && x.t === 1, 'xPSR：Z 在 bit30、T 在 bit24');
  ok(R.decodeXpsr(0x00000010).isr === 16, 'xPSR：IPSR 在 [8:0]（异常号）');
  const it = R.decodeXpsr((3 << 25) | (0x2a << 10));   // IT = {[26:25]=11, [15:10]=101010}
  ok(it.it === 0xea, `xPSR：IT 拆在两段（[26:25] 是高位）→ 0x${it.it.toString(16)}`);
  ok(/Z=1/.test(R.formatXpsr(0x41000000)) && /Handler #3/.test(R.formatXpsr(3)), 'formatXpsr 有人话（含 Handler）');

  const f = R.setXpsrFlags(0x01000000, { z: 1, c: 0 });
  ok(f === 0x41000000, 'setXpsrFlags 只动指定标志位（T 位等原样保留）', '0x' + f.toString(16));

  // CFBP 的字节顺序：依据 OpenOCD armv7m.c（PRIMASK 在最低字节、CONTROL 在最高字节）
  const packed = R.cfbpSet(R.cfbpSet(0, 'PRIMASK', 1), 'CONTROL', 2);
  ok(packed === 0x02000001, 'CFBP 打包：PRIMASK→byte0、CONTROL→byte3', '0x' + packed.toString(16));
  ok(R.cfbpGet(0x00010203, 'PRIMASK') === 1 && R.cfbpGet(0x00010203, 'BASEPRI') === 0x02
     && R.cfbpGet(0x00010203, 'FAULTMASK') === 1 && R.cfbpGet(0x00010203, 'CONTROL') === 0,
     'CFBP 拆包：byte0=PRIMASK / byte1=BASEPRI / byte2=FAULTMASK / byte3=CONTROL');
  ok(R.cfbpSet(packed, 'PRIMASK', 0) === 0x02000000, 'CFBP 改一个字节不会碰兄弟字节');
  ok(/非特权/.test(R.formatControl(1)) && /用 PSP/.test(R.formatControl(2)), 'CONTROL 的人话（nPRIV/SPSEL）');
}

// ==================================================================== 3
console.log('== 3. FPB 硬件断点的编码 ==');
{
  const ctrl = B.decodeFpCtrl(0x00000080);
  ok(ctrl.numCode === 8 && ctrl.rev === 1, 'FP_CTRL=0x80 → 8 个比较器、rev1（Cortex-M7 的排法）', JSON.stringify(ctrl));
  ok(B.decodeFpCtrl(0x10000080).rev === 2, 'REV 字段在 [31:28]（0x1 → rev2）');

  ok(B.canBreak(0x08000123, 1) === true && B.canBreak(0x90000000, 1) === false,
     'rev1 只能匹配 0x20000000 以下的地址（H7 的 QSPI 代码就打不了）');
  ok(B.canBreak(0x90000000, 2) === true, 'rev2 地址不限');

  const even = B.encodeComparator(0x08000100, 1);
  ok(even === 0x48000101, 'rev1 偶数地址 → (addr&~3) | BP_MATCH(0x1<<30) | ENABLE', '0x' + even.toString(16));
  const odd = B.encodeComparator(0x08000102, 1);
  ok(odd === 0x88000101, 'rev1 上半字地址 → BP_MATCH(0x2<<30)（bit1 不进地址字段）', '0x' + odd.toString(16));
  ok(B.decodeComparator(odd, 1).addr === 0x08000102, 'rev1 解码要把 bit1 从 BP_MATCH 还回来', '0x' + B.decodeComparator(odd, 1).addr.toString(16));
  ok(B.encodeComparator(0x08000102, 2) === 0x08000103, 'rev2 只按半字对齐 + ENABLE');
  ok(B.decodeComparator(even, 1).addr === 0x08000100 && B.decodeComparator(even, 1).enabled === true,
     '编码 → 解码可往返（探针回读对账靠它）');

  const plan = B.planComparators([0x08000100, 0x08000200, 0x90000000], 2, 1);
  ok(plan.slots.length === 2 && plan.slots[0] !== null && plan.slots[1] !== null, 'planComparators 按顺序填槽位');
  ok(plan.bad.length === 1 && plan.bad[0] === 0x90000000, '超出匹配范围的地址单独报出来（不静默丢）');
  const over = B.planComparators([1, 2, 3], 2, 1);
  ok(over.overflow.length === 1 && over.overflow[0] === 3, '装不下的断点进 overflow');
}

// ==================================================================== 4
console.log('== 4. 符号表（拿真 ELF 当靶子）==');
const elfPath = join(here, '..', 'fixtures', 'dwarf', 'stm32f103_rtt_speed.elf');
const elfBuf = readFileSync(elfPath);
let symtab = null;
{
  symtab = SY.SymTab.fromBuffer(new Uint8Array(elfBuf));
  ok(symtab.size > 50, `解析出 ${symtab.size} 个符号`);
  const rtt = symtab.find('_SEGGER_RTT');
  ok(rtt && rtt.addr === 0x2000000c && rtt.size === 96, '_SEGGER_RTT 的地址/大小正确', JSON.stringify(rtt));
  const f = symtab.find('SysTick_Handler');
  ok(f && f.kind === 'func' && f.addr === 0x08000040, '按名字找到函数并给出类型', JSON.stringify(f));

  const at = symtab.funcAt(0x08000044);
  ok(at && at.name === 'SysTick_Handler' && at.off === 4 && at.exact, 'PC 落点：函数名 + 偏移', JSON.stringify(at));
  ok(symtab.nameOf(0x08000044) === 'SysTick_Handler+0x4', 'nameOf 的人话格式');

  const r1 = symtab.resolve('SysTick_Handler+0x8');
  ok(r1 && r1.addr === 0x08000048, 'resolve 支持「符号+偏移」', JSON.stringify(r1));
  const r2 = symtab.resolve('0x2000000c');
  ok(r2 && r2.addr === 0x2000000c && r2.sym === null, 'resolve 支持裸十六进制');
  const r3 = symtab.resolve('&g_bytes');
  ok(r3 && r3.addr === 0x20000000, 'resolve 支持 &变量');
  ok(symtab.resolve('不存在的符号') === null, 'resolve 找不到就回 null（命令层要报错）');

  const hits = symtab.search('RTT');
  ok(hits.length >= 3 && hits.some(h => h.name === '_SEGGER_RTT'), `sym 搜索命中 ${hits.length} 条`);
  ok(/符号/.test(symtab.summary()), 'summary 有人话摘要：' + symtab.summary());
}

// ==================================================================== 5
console.log('== 5. 会话 + 假目标：真跑一遍调试动作 ==');
const session = new S.DebugSession();
const logs = [];
session.log = (t, c) => logs.push((c ? `[${c}] ` : '') + t);
let haltWait = null;                     // 轮询等目标停下（页面里由 _watchLoop 干这件事）
{
  await session.connect({ mock: true });
  ok(session.connected, '连上假目标');
  ok(session.halted === true, '连上时的状态是"已停止"');
  ok(session.caps.numCode === 8 && session.caps.rev === 1, '读到 FPB 能力：8 个比较器 rev1', JSON.stringify(session.caps));

  const regs = await session.refreshRegs();
  ok(regs.length === 23, `读回 23 个寄存器（19 内核含 MSP/PSP/XPSR + 4 个特殊）`, String(regs.length));
  const pc = regs.find(r => r.name === 'PC').value;
  ok(pc === 0x08000100, '复位向量取到了代码区入口', '0x' + pc.toString(16));
  ok(regs.find(r => r.name === 'SP').value === 0x20010000, 'SP 来自向量表');
  ok((regs.find(r => r.name === 'XPSR').value >>> 24 & 1) === 1, 'xPSR.T = 1（Thumb）');

  // 写寄存器
  await session.writeReg('R0', 0xdeadbeef);
  ok(await session.readReg('R0') === 0xdeadbeef, '读回写进去的 R0');
  await session.writeReg('PC', 0x08000200);
  ok(await session.readReg('PC') === 0x08000200, '改 PC 生效');

  // CFBP：写 PRIMASK 不应碰 CONTROL（字节顺序的端到端验证）
  await session.writeReg('CONTROL', 2);
  await session.writeReg('PRIMASK', 1);
  const cfbpRaw = await session.readReg('cfbp');
  ok(cfbpRaw === 0x02000001, 'CFBP 端到端：PRIMASK=1 落在 byte0、CONTROL=2 落在 byte3', '0x' + cfbpRaw.toString(16));
  ok(await session.readReg('PRIMASK') === 1 && await session.readReg('CONTROL') === 2, '两个特殊寄存器各读各的');
  await session.writeReg('PRIMASK', 0);

  // 内存
  await session.memWrite(0x20000000, Uint8Array.from([0x11, 0x22, 0x33, 0x44]));
  const back = await session.memRead(0x20000000, 4);
  ok(back[0] === 0x11 && back[3] === 0x44, '写内存后回读一致');
  let flashErr = '';
  try { await session.memWrite(0x08000000, Uint8Array.of(1)); } catch (e){ flashErr = e.message; }
  ok(/flash/.test(flashErr), '写 flash 会被拒绝（假目标与真板子一致：本页不做烧录）', flashErr);

  // 断点：下在 PC 前面，继续，等它命中
  await session.bpAdd(0x08000300);
  ok(session.bpList().length === 1 && session.bpList()[0].addr === 0x08000300, '断点加进去了');
  ok(session.caps.numCode === 8 || session.bpCapacity === 8, '硬件上限 = FPB 报的 8 个比较器');
  await session.cont();
  ok(session.halted === false, '「继续」之后目标在跑');
  haltWait = async (ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms){
      await sleep(30);
      await session.refresh();
      if (session.halted) return true;
    }
    return false;
  };
  ok(await haltWait(), '目标在 3 s 内停了下来（命中假目标里的 FPB 比较器）');
  ok(session.pc === 0x08000300, '停在了断点地址上', '0x' + session.pc.toString(16));

  // 再继续：应当"跨过断点"后绕一圈再命中，而不是原地卡住
  await session.cont();
  const t1 = Date.now();
  ok(await haltWait(3000), '第二次「继续」也命中（跨过断点后绕回来）');
  ok(session.pc === 0x08000300, '仍停在同一地址（说明真的跨过去又回来了）', '0x' + session.pc.toString(16));
  ok(Date.now() - t1 > 20, '跨过断点确实是"跑了一段"而不是立即返回');

  // 单步：从断点地址起步应当往前走 2 字节（step 内部会临时摘掉比较器）
  await session.step();
  ok(session.pc === 0x08000302, '在断点处单步能走开（临时摘比较器）', '0x' + session.pc.toString(16));
  ok(session.bpList().length === 1, '单步之后比较器装回去了');

  // 删断点 / 清空
  ok(await session.bpDel(0x08000300) === true, '删断点');
  ok(session.bpList().length === 0, '断点表空了');

  // 复位
  await session.resetHalt();
  ok(await session.readReg('PC') === 0x08000100, '复位并停：PC 回到复位向量');
  ok(session.halted === true, '复位并停：状态是"已停止"');
  await session.resetRun();
  ok(session.halted === false, '复位并跑：状态是"运行中"');
  await session.halt();
  ok(session.halted === true, '再暂停回来');
}

// ==================================================================== 6
console.log('== 6. 命令行（跑在同一个会话上）==');
{
  session.sym = symtab;
  const run = async line => (await C.runCmd(line, session)).lines.map(l => l.t);

  const help = await run('h');
  ok(help.length > 10 && help.some(l => /md <地址>/.test(l)), 'h 打印帮助');

  let threw = '';
  try { await C.runCmd('nosuchcmd', session); } catch (e){ threw = e.message; }
  ok(/不认识的命令/.test(threw), '不认识的命令要报错（不能静默无反应）', threw);

  const r0 = await run('r r0');
  ok(r0.length === 1 && /R0/.test(r0[0]) && /0xdeadbeef/.test(r0[0]), 'r r0 打印一个寄存器', r0[0]);

  const warp = await run('r PC 0x08000200');
  ok(/←/.test(warp[0]) && await session.readReg('PC') === 0x08000200, 'r PC <值> 写进去了');
  threw = '';
  try { await C.runCmd('r r0 0xZZ', session); } catch (e){ threw = e.message; }
  ok(/认不出数值/.test(threw), 'r <reg> <坏值> 报错而不是静默', threw);

  const mw = await run('mw 0x20000020 01 02 03 04');
  ok(/回读一致/.test(mw[0]), 'mw 写内存并回读对账', mw[0]);
  const md = await run('md 0x20000020 16');
  ok(md.length >= 2 && /0x20000020  01 02 03 04/.test(md[1]), 'md 打印 hexdump', md[1]);

  const bp = await run('b SysTick_Handler');
  ok(/断点 #1/.test(bp[0]) && session.bpList()[0].addr === 0x08000040, 'b <符号> 走符号表解析', bp[0]);
  const bl = await run('bl');
  ok(bl.some(l => /#1/.test(l)) && bl.some(l => /硬件上限 8/.test(l)), 'bl 列出断点与硬件上限');
  const bd = await run('bd 1');
  ok(/删掉断点/.test(bd[0]) && session.bpList().length === 0, 'bd 1 按编号删断点');

  const p = await run('p g_bytes');
  ok(p.length === 1 && /g_bytes/.test(p[0]), 'p 打印变量（有 DWARF 就解数值）', p[0]);
  await session.memWrite(0x20000000, Uint8Array.from([0x11, 0x22, 0x33, 0x44]));
  const p2 = await run('p g_bytes');
  ok(/0x44332211|11 22 33 44/.test(p2[0]), 'p 打出来的值对得上刚写的字节', p2[0]);

  const info = await run('info');
  ok(info.some(l => /后端/.test(l)) && info.some(l => /状态/.test(l)), 'info 有后端/状态/符号');

  const syms = await run('sym RTT');
  ok(syms.some(l => /_SEGGER_RTT/.test(l)), 'sym 搜符号');

  const x = await run('x &g_bytes 8');
  ok(x.some(l => /g_bytes/.test(l)), 'x &变量 先解释符号再 dump');

  // md 的边界
  threw = '';
  try { await C.runCmd('md', session); } catch (e){ threw = e.message; }
  ok(/用法/.test(threw), 'md 缺参数时报用法', threw);
  threw = '';
  try { await C.runCmd('md 0x20000000 99999', session); } catch (e){ threw = e.message; }
  ok(/1~4096/.test(threw), 'md 长度上限有保护', threw);
}

// ==================================================================== 7
console.log('== 7. 没连接时的命令（不能崩，要给人话）==');
{
  const s2 = new S.DebugSession();
  let threw = '';
  try { await C.runCmd('c', s2); } catch (e){ threw = e.message; }
  ok(/还没连接/.test(threw), '未连接时 c 提示先连接', threw);
  const help = await C.runCmd('h', s2);
  ok(help.lines.length > 5, '未连接时 h 仍然可用');
}

// ==================================================================== 8
console.log('== 8. 行号表（DWARF .debug_line）：停下来显示源码行的地基 ==');
{
  ok(!!symtab.lines, '载入 ELF 时顺带解析出了行号表');
  ok(symtab.lines.size > 100, `行号记录 ${symtab.lines.size} 条`, String(symtab.lines?.size));
  ok(symtab.lines.units === 3, `3 个编译单元（每段一个行号程序）`, String(symtab.lines.units));
  ok(symtab.lines.versions.includes(4), 'CU 版本是 DWARF 4', JSON.stringify(symtab.lines.versions));
  ok(symtab.lines.paths.some(p => p.endsWith('/src/main.c')), '源文件表里有 src/main.c');
  ok(LN.cleanPath('E:\\a\\..\\b/c.c') === 'E:/b/c.c' && LN.cleanPath('/x/./y') === '/x/y', 'cleanPath 归一化（盘符/`..`/`.`）');
  ok(LN.isAbsPath('E:/x') && LN.isAbsPath('/usr/x') && !LN.isAbsPath('src/main.c'), 'isAbsPath 认盘符与 Unix 根');
  ok(LN.relTo('E:/proj', 'E:/proj/src/main.c') === 'src/main.c', 'relTo 算相对路径');

  const st = symtab.at(0x08000040);
  ok(st && st.line === 24 && /main\.c$/.test(st.file) && st.isStmt, 'SysTick_Handler 的首地址 → src/main.c:24', JSON.stringify(st));
  const mn = symtab.at(0x08000051);
  ok(mn && mn.line === 28, 'main+0 → src/main.c:28', JSON.stringify(mn));
  ok(symtab.locText(0x08000040) === 'main.c:24', 'locText 给"文件:行"的人话：' + symtab.locText(0x08000040));

  // 🚨 地址 0 / 非代码段的假记录必须被剔掉（编译器的"占位序列"会落在 0,2,4…）
  let minAddr = Infinity;
  for (let i = 0; i < symtab.lines.size; i++) minAddr = Math.min(minAddr, symtab.lines.starts[i]);
  ok(minAddr >= 0x08000000, `最小记录地址在代码段里（0x${minAddr.toString(16)}）—— 占位序列被剔掉了`);
  ok(symtab.at(0) === null && symtab.at(0x20000000) === null, '地址 0 / RAM 地址查不到行号（回 null 而不是乱指一行）');

  // 反查：行 → 地址 → 行，必须一一对上（点源码行下断点全靠它）
  let okN = 0, badN = 0;
  for (let i = 0; i < symtab.lines.size; i++){
    const fi = symtab.lines.files[i];
    if (fi < 0) continue;
    const p = symtab.lines.paths[fi], ln = symtab.lines.lines[i];
    const a = symtab.lines.addrOfLine(p, ln);
    const back = a == null ? null : symtab.lines.at(a);
    if (back && back.line === ln && back.file === p) okN++; else badN++;
  }
  ok(badN === 0 && okN > 100, `行→地址→行 全部自洽（${okN} 条，${badN} 条不一致）`);

  // 没有行号信息的 ELF：不能让整页挂掉
  const bare = SY.SymTab.fromBuffer(new Uint8Array(elfBuf));
  ok(bare.lines === null || bare.lines.size > 0, 'SymTab.lines 要么有表要么是 null（两种都不能崩）');

  // 🚨 DWARF 5 + 0x8xxxxxxx 地址：`addr & ~1` 在 JS 里会变成负数，忘了 `>>> 0` 就一条都查不到
  const rvSym = SY.SymTab.fromBuffer(new Uint8Array(readFileSync(join(here, '..', 'fixtures', 'dwarf', 'riscv_dwarf5.elf'))));
  ok(!!rvSym.lines && rvSym.lines.size > 0, 'DWARF 5 的行号表也能解析（riscv_dwarf5.elf）', String(rvSym.lines?.size));
  const rvAt = rvSym.at(0x80000000);
  ok(rvAt && rvAt.line === 8 && /fixture\.c$/.test(rvAt.file), '0x80000000 查得到行号（有符号位那个坑的回归测试）', JSON.stringify(rvAt));
}

// ==================================================================== 8.1
console.log('== 8.1 源码文件仓（选择目录后的匹配与读取）==');
{
  const SR = await import(url('dbg/source.js'));
  const store_ = new SR.SourceStore();
  const mkFile = (rel, text) => ({ name: rel.split('/').pop(), webkitRelativePath: 'proj/' + rel, text: async () => text, size: text.length });
  const sum = store_.indexFileList([mkFile('src/main.c', 'int main(void){\n  return 0;\n}\n'), mkFile('src/app/loop.c', 'void loop(void){}\n')]);
  ok(store_.ready && store_.count === 2, '索引 FileList（webkitdirectory 兜底路径）：' + sum);
  ok(store_.resolve('E:/proj/src/main.c')?.rel === 'src/main.c', '按后缀匹配 ELF 里的绝对路径（编译机路径 ≠ 本机路径）');
  ok(store_.resolve('/home/ci/build/src/app/loop.c')?.rel === 'src/app/loop.c', '多级后缀也能匹配');
  ok(store_.resolve('E:/other/nope.c') === null, '匹配不上就回 null（界面显示"没找到源文件"，不乱猜）');
  const txt = await store_.read('E:/proj/src/main.c');
  ok(txt.includes('int main'), '读源码文本（走缓存）');
  const again = await store_.read('E:/proj/src/main.c');
  ok(again === txt, '第二次读走缓存（同一份内容）');
  let msg = '';
  try { await store_.read('E:/proj/src/missing.c'); } catch (e){ msg = e.message; }
  ok(/找不到/.test(msg) && /选择源码目录/.test(msg), '读不到时给人话（告诉用户去选目录）', msg);
}

// ==================================================================== 9
console.log('== 9. 监视窗口（表达式解析 / 取值 / 增删）==');
{
  const v = W.resolveWatch('g_bytes', symtab);
  ok(v.addr === 0x20000000 && !v.error, 'w 变量名 → 解析到地址', JSON.stringify(v));
  const off = W.resolveWatch('g_bytes+4', symtab);
  ok(off.addr === 0x20000004 && off.kind === 'addr', 'w 符号+偏移 → 按 u32 看那个地址', JSON.stringify(off));
  const raw = W.resolveWatch('0x20000010', symtab);
  ok(raw.addr === 0x20000010 && raw.scalar === 'u32', 'w 裸地址 → 按 u32 读');
  ok(W.resolveWatch('没这个符号', symtab).error?.includes('找不到'), 'w 认不出来 → 给错误（不静默）');
  ok(W.resolveWatch('g_bytes', null).error?.includes('elf'), '没载入 ELF 时 w 说明原因');

  const bytes = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const fv = W.formatWatchValue({ scalar: 'u32', typeName: 'u32', size: 4 }, bytes);
  ok(fv.text === String(0x44332211) && fv.hex === '0x44332211', 'u32 取值：十进制 + 十六进制', JSON.stringify(fv));
  const fraw = W.formatWatchValue({ scalar: null, typeName: '4 字节', size: 4 }, bytes);
  ok(/44332211/.test(fraw.text + fraw.hex), '没有类型信息时也要给出人看得懂的十六进制', JSON.stringify(fraw));

  const list = new W.WatchList();
  const a1 = list.add('g_bytes', symtab);
  ok(!a1.dup && list.length === 1, '加一项监视');
  const a2 = list.add('g_bytes', symtab);
  ok(a2.dup && list.length === 1, '同名不重复加（返回 dup）');
  list.add('g_bytes+4', symtab);
  list.add('0x20000010', symtab);
  ok(list.length === 3, '一共 3 项');
  ok(list.remove('2').removed === 1 && list.length === 2, 'wd 按编号删');
  ok(list.remove('0x20000010').removed === 1 && list.length === 1, 'wd 按名字删');
  const json = list.toJSON();
  ok(Array.isArray(json) && json[0].expr === 'g_bytes' && json[0].value === undefined, 'toJSON 不把值存进 localStorage');
  const back = W.WatchList.fromJSON(json, symtab);
  ok(back.length === 1 && back.items[0].addr === 0x20000000, 'fromJSON 重新解析（换 ELF 后地址会跟着变）');
  ok(list.remove('all').removed === 1 && list.length === 0, 'wd all 全清');
}

// ==================================================================== 10
console.log('== 10. Tab 补全（命令名 / 符号 / 寄存器）==');
{
  ok(CP.commonPrefix(['main', 'mainloop', 'ma']) === 'ma', 'commonPrefix 取最长公共前缀');
  const all = CP.completeLine('', {});
  ok(all.total === CP.CMD_NAMES.length && all.candidates.length > 10, '空行 Tab → 列出全部命令名');
  const h = CP.completeLine('he', {});
  ok(h.total === 1 && h.value === 'help ', '唯一候选补全并补一个空格：' + JSON.stringify(h.value));

  const syms = { sym: symtab, regs: ['pc', 'primask'] };
  const b = CP.completeLine('b ma', syms);
  ok(/^b (main|mainloop)/.test(b.value) && b.total >= 1, 'b <前缀> → 补符号名：' + JSON.stringify(b.value));
  const p = CP.completeLine('p _SEG', syms);
  ok(p.value.startsWith('p _SEGGER_RTT') && p.total >= 1, 'p _SEG → 补出 _SEGGER_RTT*（有多个就补公共前缀）：' + JSON.stringify(p.value));
  const r = CP.completeLine('r pr', syms);
  ok(r.value === 'r primask' && r.kind === 'reg', 'r 后面补寄存器名：' + JSON.stringify(r.value));
  const none = CP.completeLine('md zzz', syms);
  ok(none.total === 0 && none.value === 'md zzz', '没有候选时原样不动（绝不猜一个最近的）');
  const many = CP.completeLine('b m', syms);
  ok(many.total > 1 && many.value.length >= 'b m'.length, '多个候选 → 只补公共前缀（候选交给界面列出来）');
}

// ==================================================================== 11
console.log('== 11. 新命令：w / wl / wd / sl / src + Ctrl+C 取消 ==');
{
  const s3 = new S.DebugSession();
  s3.log = () => {};
  await s3.connect({ mock: true });
  s3.sym = symtab;
  const calls = [];
  const vw = {
    addWatch(expr){ calls.push('add:' + expr); return { ok: true, index: 0, item: { expr, addr: 0x20000000 } }; },
    watchItems(){ return [{ expr: 'g_bytes', label: 'g_bytes', addr: 0x20000000, value: { text: '7' } }]; },
    delWatch(w){ calls.push('del:' + w); return { removed: 1 }; },
    showSource(f, l){ calls.push(`src:${f}:${l}`); return !/没有这个文件/.test(f); },
  };
  const run = async (l) => (await C.runCmd(l, s3, { view: vw })).lines.map(x => x.t);

  const w = await run('w g_bytes');
  ok(/监视 \+ g_bytes/.test(w[0]) && calls.includes('add:g_bytes'), 'w <变量> 加进监视窗口', w[0]);
  const wl = await run('wl');
  ok(wl.some(l => /g_bytes/.test(l) && /#1/.test(l)), 'wl 列出监视项与值', wl[0]);
  const wd = await run('wd 1');
  ok(/已删掉 1 项/.test(wd[0]) && calls.includes('del:1'), 'wd 1 删掉监视项', wd[0]);
  const wbad = await (async () => { try { await run('w'); return ''; } catch (e){ return e.message; } })();
  ok(/用法/.test(wbad), 'w 缺参数报用法', wbad);

  const sl = await run('sl');
  ok(sl.some(l => /\.c:\d+/.test(l)), 'sl 打印当前源码位置', sl[0]);
  ok(calls.some(c => c.startsWith('src:')), 'sl 顺手把源码视图跳过去');
  const srcList = await run('src');
  ok(srcList.some(l => /main\.c/.test(l)), 'src 不带参数列出源文件', srcList[1]);
  const srcJump = await run('src main.c:24');
  ok(/跳到/.test(srcJump[0]), 'src <文件:行> 跳转', srcJump[0]);
  const srcBad = await (async () => { try { await run('src 没有这个文件.c:1'); return ''; } catch (e){ return e.message; } })();
  ok(/没有这个文件/.test(srcBad), 'src 找不到文件时报错（不静默）', srcBad);

  // Ctrl+C：signal 返回 true → 抛 Cancelled，界面显示成 ^C
  let cancelled = false;
  try { await C.runCmd('md 0x20000000 16', s3, { signal: () => true }); }
  catch (e){ cancelled = !!e.cancelled; }
  ok(cancelled, 'Ctrl+C（signal=true）时命令抛 Cancelled，不再往下跑');
  let notCancelled = false;
  try { await C.runCmd('md 0x20000000 16', s3, { signal: () => false }); notCancelled = true; } catch { notCancelled = false; }
  ok(notCancelled, 'signal=false 时命令照常执行');

  // 没界面时 w/wl/wd 要给人话错误（而不是崩）
  let noView = '';
  try { await C.runCmd('w g_bytes', s3); } catch (e){ noView = e.message; }
  ok(/界面/.test(noView), '没有界面时 w 说明"需要界面支持"', noView);
}

// ==================================================================== 12
console.log('== 12. SWD 时钟：默认 10 MHz + PPB 坏读自动退回 1 MHz ==');
{
  ok(S.DEFAULT_CLOCK_KHZ === 10000, `默认时钟是 10 MHz（${S.DEFAULT_CLOCK_KHZ} kHz）`);
  const s4 = new S.DebugSession();
  s4.log = () => {};
  await s4.connect({ mock: true, clockKhz: 10000 });
  const p = s4.probe;

  // ① 好探针：10 MHz 下 DHCSR 读得干净 → 不动时钟
  p.clockHz = 10_000_000; s4.clockHz = 10_000_000;
  p.ppbGarbage = false;
  const okRes = await s4.verifyClock();
  ok(okRes.ok === true && okRes.checked === true && s4.clockHz === 10_000_000, 'PPB 读数正常 → 保持 10 MHz', JSON.stringify(okRes));

  // ② 坏探针（高时钟读 PPB 回 0）→ 自动退回 1 MHz，并把证据写进日志
  const logs = [];
  s4.log = (t) => logs.push(t);
  p.ppbGarbage = true;
  const badRes = await s4.verifyClock();
  ok(badRes.ok === false && s4.clockHz === S.PPB_SAFE_HZ, 'PPB 读回 0 → 自动退回 1 MHz', JSON.stringify(badRes));
  ok(p.clockHz === S.PPB_SAFE_HZ, '探针那边的 SWJ_Clock 也真的改了', String(p.clockHz));
  ok(logs.some(l => /已自动退回 1 MHz/.test(l)), '日志里说清"为什么退回"（不许静默降级）', logs.join(' | ').slice(0, 140));

  // ③ 已经 ≤1 MHz 就不再折腾（不白读三次）
  const skip = await s4.verifyClock();
  ok(skip.ok === true && skip.checked === false, '已经 ≤1 MHz 时跳过检查', JSON.stringify(skip));
  await s4.disconnect();
}

// ==================================================================== 13
console.log('== 13. SWD 串行化（后台轮询不许和用户动作交错）==');
{
  const s5 = new S.DebugSession();
  s5.log = () => {};
  await s5.connect({ mock: true });
  const order = [];
  const op = s5.exclusive(async () => { order.push('op:start'); await sleep(60); order.push('op:end'); });
  await sleep(10);
  const bg = await s5.tryExclusive(async () => { order.push('bg'); });
  ok(bg.skipped === true && !order.includes('bg'), '独占动作进行中 → 后台轮询跳过这一拍（不排队、不交错）', JSON.stringify(order));
  await op;
  const bg2 = await s5.tryExclusive(async () => { order.push('bg2'); return 7; });
  ok(bg2.skipped === false && bg2.value === 7 && order[order.length - 1] === 'bg2', '空闲时后台轮询正常执行', JSON.stringify(order));

  const seq = [];
  const a = s5.exclusive(async () => { seq.push('A1'); await sleep(40); seq.push('A2'); });
  const b = s5.exclusive(async () => { seq.push('B1'); await sleep(10); seq.push('B2'); });
  await Promise.all([a, b]);
  ok(seq.join(',') === 'A1,A2,B1,B2', '两个独占动作排队：A 全程跑完才轮到 B', seq.join(','));
  ok(s5._opBusy === false, '队列跑空后锁已释放', String(s5._opBusy));
  await s5.disconnect();
}

console.log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
