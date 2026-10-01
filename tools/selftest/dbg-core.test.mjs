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

console.log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
