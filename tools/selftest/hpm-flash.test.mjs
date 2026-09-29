/**
 * HPM（RISC-V）WebUSB 烧录 —— **全离线**自测（不需要探针/板子）。
 *
 *   node tools/selftest/hpm-flash.test.mjs
 *
 * 这一份测的不是"打桩常量"，而是把**真实代码**跑在**模拟目标**上：
 *   tools/selftest/hpm-sim.mjs 实现了 TAP 状态机 + DTM/DMI + Debug Module + SBA + XPI flash，
 *   并且真的按位解释 app/flash/hpm/jtag.js 生成的 JTAG 序列 —— 所以位序、DMI 流水线、
 *   SBA 自增、抽象命令这些协议细节都会被验到。
 *
 * ⚠️ 覆盖不到的（真机 bring-up 才能验）：真实 JTAG 时钟/时序、DMI busy 的真实时序、
 *    ROM API 内部的 XPI 寄存器舞蹈、真实 flash 的擦写时间与 SFDP 探测、探针 output_mode 设置。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const url = p => 'file://' + join(root, p).replace(/\\/g, '/');

globalThis.atob = globalThis.atob || (s => Buffer.from(s, 'base64').toString('binary'));

const J = await import(url('app/flash/hpm/jtag.js'));
const { RiscvTransport } = await import(url('app/flash/hpm/riscv-dm.js'));
const { HpmFlasher, hpmStatusText } = await import(url('app/flash/hpm/flash.js'));
const { HPM_ALGO, hpmAlgoBytes } = await import(url('app/flash/hpm/algo.js'));
const E = await import(url('app/flash/hpm/entry.js'));
const C = await import(url('app/flash/hpm/chips.js'));
const { SimTarget } = await import(url('tools/selftest/hpm-sim.mjs'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ 1
console.log('== 1. flashloader blob 与入口表 ==');
{
  const bytes = hpmAlgoBytes();
  ok(bytes.length === HPM_ALGO.size && bytes.length > 1000 && bytes.length < 4096,
     `blob ${bytes.length} B（-nostdlib + 自带 memset，别链 newlib 否则 16 KB）`);
  const parsed = E.algoEntries(bytes);
  ok(parsed.count === 7, `入口表解析出 ${parsed.count} 个入口（7 个：init/erase/program/read/info/eraseChip/deinit）`);
  // 表项步长是 4 B jal + 2 B c.ebreak = 6 B —— 这正是"不能假设 8 B"的那个坑
  ok(parsed.list[1].entryOffset === 6, `表项步长 6 B（c.ebreak 是 2 字节），第 2 项偏移 = ${parsed.list[1].entryOffset}`);
  const names = { init: 'flash_init', erase: 'flash_erase', program: 'flash_program',
                  read: 'flash_read', info: 'flash_get_info', eraseChip: 'flash_erase_chip', deinit: 'flash_deinit' };
  let mismatch = [];
  for (const [k, sym] of Object.entries(names)){
    if (parsed.byName[k].target !== HPM_ALGO.symbols[sym]) mismatch.push(`${k}: 0x${parsed.byName[k].target.toString(16)} vs 0x${HPM_ALGO.symbols[sym].toString(16)}`);
  }
  ok(mismatch.length === 0, '解析出的跳转目标与构建时的符号地址逐项一致', mismatch.join('; '));
  ok(HPM_ALGO.loadAddr === 0 && HPM_ALGO.symbols.flash_init > 0, '加载地址 0x00000000（与 SDK 的 work-area 一致）');
  // 解析器要能识别"不是表"的输入（别死循环/别乱报）
  ok(E.parseAlgoEntryTable(new Uint8Array(16).fill(0xff)).length === 0, '全 0xFF 的垃圾不进表（不会当成入口）');
  ok(E.parseAlgoEntryTable(new Uint8Array(0)).length === 0, '空 blob 返回空表');
  // 🚨 c.jal 的立即数符号位是 bit11（0x800）：0x3fd5 应解出 -12（objdump 也是 -12）。
  //    判据写成 `imm >= 0x1000` 的话永远不成立（12 位立即数最大 0xFFF），负偏移会被解成正的大数 —— 踩过。
  ok(E.cjalOffset(0x3fd5) === -12, `c.jal 负偏移符号扩展正确：0x3fd5 → ${E.cjalOffset(0x3fd5)}（期望 -12）`);
  ok(E.cjalOffset(0x2011) === 4, `c.jal 正偏移：0x2011 → ${E.cjalOffset(0x2011)}（期望 4）`);
  // 🚨 机器码级结构自检：2026-10 真机 bring-up 的教训 —— memset.c 被 GCC 的循环识别
  //    优化成"调自己"的无限递归，blob 大小/入口表/离线自测全正常，只有真机才表现为"烧录卡死"。
  const chk = await import(url('tools/target-firmware/hpm_flash_algo/check-algo.mjs'));
  const chkRes = chk.checkAlgo(bytes);
  ok(chkRes.problems.length === 0, 'blob 机器码结构自检：无"无出口自循环/自递归"', chkRes.problems.join('; '));
  const bug = new Uint8Array(bytes);
  bug[0x544] = 0xd5; bug[0x545] = 0x3f; bug[0x538] = 0x41; bug[0x539] = 0x11;   // 手工造一个 c.jal 自己
  ok(chk.findSuspiciousLoops(bug).length > 0, '自检能抓出"c.jal 跳回自己"这种死循环（拿旧 bug 的形状反验）');
}

// ------------------------------------------------------------------ 2
console.log('== 2. JTAG/DMI 编码（照探针固件 riscv_jtag.c 的位序）==');
{
  const irSeq = J.tapLoadIR(0x11);
  ok(irSeq.length === 6 && irSeq[0].info === 0x42 && irSeq[1].info === 0x02,
     '装 IR 的序列形状：2 拍 TMS=1 → 2 拍 TMS=0 → 4 bit → 1 bit → Update → RTI');
  ok(irSeq[2].tdi[0] === 0x1 && irSeq[3].tdi[0] === 1, 'IR=0x11 的位序：低 4 位先出、第 5 位最后');
  const rs = J.tapReset();
  ok(rs.length === 7 && rs[0].info === 0x48 && rs[6].info === 0x01, 'TAP 复位：6 × (8 拍 TMS=1) + 1 拍 TMS=0');
  const dmi = J.dmiRequest(J.DMI_OP.WRITE, J.DM.SBADDRESS0, 0x80000000);
  const back = J.dmiResponse(dmi);
  ok(back.op === J.DMI_OP.WRITE && back.data === 0x80000000, 'DMI 41 位请求编码/解码往返一致');
  ok(dmi === (2n | (0x80000000n << 2n) | (0x39n << 34n)), '41 位布局：op(2) | data(32)<<2 | addr(7)<<34');
  const dr = J.drScan(41, 0n, { idle: 7 });
  ok(dr[0].clocks === 7 && dr[1].clocks === 1 && dr[2].clocks === 2,
     `DR 扫描先跑 idle 拍（dtmcs 要求 7 拍），实际 ${dr[0].clocks}`);
  ok(dr[3].clocks === 40 && dr[4].clocks === 1 && dr[5].info === 0x41, '41 位 = 40 + 1（最后一位在 Exit1-DR）');
  ok(dr[3].captureBytes > 0 && dr[4].captureBytes > 0 && dr[0].captureBytes === 0,
     '只有移位段捕获 TDO（idle/状态迁移段不捕）');
  const cmd = J.abstractCommand({ write: true, regno: J.REGNO.PC, data: 0x50 });
  ok(J.REGNO.PC === 0x7b1, `dpc 的抽象命令编号 = 0x${J.REGNO.PC.toString(16)}（规范 §3.14；写错就永远跳不到算法入口）`);
  ok(cmd.command === ((2 << 20) | (1 << 17) | (1 << 16) | 0x7b1) && cmd.data === 0x50,
     `抽象命令：写 dpc = 0x${cmd.command.toString(16)}（aarsize=2 | transfer | write | regno=0x7b1）`);
  let threw = false;
  try { J.abstractCommand({ regno: 0x10000 }); } catch { threw = true; }
  ok(threw, 'regno 超出 16 位会报错（x 寄存器只有 0x1000..0x101f）');
  ok(J.sbcsBlock() === (J.SBCS.SBACCESS32 | J.SBCS.SBAUTOINC | J.SBCS.SBREADONADDR | J.SBCS.SBREADONDATA),
     'SBA 块访问配置位与固件一致（32 位 + 自增 + 写地址即读 + 读数据即续读）');
}

// ------------------------------------------------------------------ 3
console.log('== 3. DM/SBA 跑在模拟 DTM 上（TAP 状态机真的按位解序列）==');
{
  const sim = new SimTarget();
  const dm = new RiscvTransport(sim, { idle: 7 });
  const info = await dm.init();
  ok(info.idcode === 0x1000563D, `IDCODE = 0x${info.idcode.toString(16)}（HPM 全系 0x1000563D）`);
  ok(info.dtmcs === 0x71, `DTMCS = 0x${info.dtmcs.toString(16)}（idle=7）`);
  ok((info.dmstatus & 0xf) === 2, `DMSTATUS version = ${info.dmstatus & 0xf}（调试规范 0.13+ 是 2）`);
  await dm.activate(0);
  ok(await dm.halt(), 'haltreq 之后 dmstatus.allhalted 置位');
  // 寄存器
  await dm.writeReg(0x1000 + 10, 0xdeadbeef);
  ok((await dm.readReg(0x1000 + 10)) === 0xdeadbeef, '抽象命令写/读 a0（x10）往返一致');
  await dm.writeReg(J.REGNO.PC, 0x00000123);
  ok((await dm.readReg(J.REGNO.PC)) === 0x00000123, '抽象命令写/读 dpc 往返一致');
  // 跑算法前的准备：dcsr.ebreak* + progbuf 里的 fence.i（真机上缺一步就"永远不结束"）
  ok(sim.dcsrEbreakEnabled === false, '模拟目标初始 dcsr 没置 ebreak*（= 全新板子，不靠上次调试器留下的状态）');
  await dm.prepareRun();
  ok(sim.dcsrEbreakEnabled === true, `prepareRun 置上了 dcsr.ebreakm（dcsr=0x${sim.dcsr.toString(16)}）`);
  ok(sim.progbufRuns >= 1 && sim.progbuf[0] === 0x0000100f && sim.progbuf[1] === 0x0330000f,
     'fence.i; fence rw,rw 走 progbuf（postexec）执行，不是写进 SRAM 再跑');
  // 算法末尾的 ebreak 只有 ebreak* 置起才 halt —— 反过来验一次模拟器是认真的
  await dm.writeMem(HPM_ALGO.loadAddr, hpmAlgoBytes());     // 入口表要在 RAM 里，模拟器才认得 resume 目标
  sim.dcsrEbreakEnabled = false;
  sim.runAlgoEntry(0, [0x80000000, 0xfcf90001, 0, 0, 0xf3000000]);
  ok(sim.trapped && !sim.halted, '模拟器照真机语义：dcsr 没置时 ebreak 变成异常 → 核不停（所以主机侧漏了就会挂）');
  sim.dcsrEbreakEnabled = true;
  sim.trapped = false;
  // SBA
  const data = new Uint8Array(64);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;
  await dm.writeMem(0x400, data);
  const back = await dm.readMem(0x400, 64);
  ok(back.every((b, i) => b === data[i]), 'SBA 块写 → 块读 64 B 逐字节一致');
  const mis = await dm.readMem(0x402, 8);
  ok(mis.every((b, i) => b === data[2 + i]), '非对齐（+2）读自动补齐头部，取到正确的 8 B');
  ok(sim.stats.sbaWrites >= 16 && sim.stats.sbaReads >= 16, `模拟目标真的执行了 SBA（写 ${sim.stats.sbaWrites} / 读 ${sim.stats.sbaReads} 次）`);
  // 流水线读（J-Scope 的单变量快路径）
  await dm.holdPrepare(0x400);
  const h1 = await dm.holdRead(), h2 = await dm.holdRead();
  ok(h1 === 0x00030201 || h1 !== h2, `hold 读拿到的是"上一次投出去的读"（延迟一拍语义，h1=0x${(h1 ?? 0).toString(16)} h2=0x${(h2 ?? 0).toString(16)}）`);
  // 地址越界要报错而不是静默
  let threw = false;
  try { await dm.writeMem(0x20000, new Uint8Array(4)); } catch { threw = true; }
  ok(threw, 'SBA 写到未映射地址 → 抛错（位 sberror 生效，不静默）');
}

// ------------------------------------------------------------------ 4
console.log('== 4. 端到端：加载 flashloader → init → 擦 → 写 → 校验 ==');
{
  const sim = new SimTarget({ flashSize: 0x40000 });
  const dm = new RiscvTransport(sim, { idle: 7 });
  await dm.init(); await dm.activate(0); await dm.halt();
  const board = C.hpmBoard('hpm6800evk');
  const flasher = new HpmFlasher(dm, { board, log: l => console.log('    · ' + l) });
  const info = await flasher.setup();
  ok(info.totalBytes === sim.flash.length && info.sectorBytes === sim.sectorSize,
     `flash_get_info 拿回真容量/扇区：${info.totalBytes / 1024} KB / ${info.sectorBytes} B`);
  ok(sim.flashInited, '模拟目标上的 flashloader 真的被 flash_init 初始化了');

  // 造一段"固件"：含 0x00/0xFF/随机，能抓出"没擦就写"和"尾块补齐"的问题
  const img = new Uint8Array(1024 * 10 + 7);
  for (let i = 0; i < img.length; i++) img[i] = (i % 251);
  img.fill(0x00, 100, 200);
  const addr = board.flashBase + 0x1000;              // 故意不从 0 开始（测偏移计算）
  await flasher.erase(addr, img.length);
  ok(sim.eraseOps === 1, `擦除调用到目标（${sim.eraseOps} 次）`);
  await flasher.program(addr, img);
  const off = addr - board.flashBase;
  let same = true, firstBad = -1;
  for (let i = 0; i < img.length; i++) if (sim.flash[off + i] !== img[i]){ same = false; firstBad = i; break; }
  ok(same, `模拟 flash 里逐字节等于固件（${img.length} B，从 0x${addr.toString(16)} 起）`,
     firstBad >= 0 ? `第 ${firstBad} 字节 0x${sim.flash[off + firstBad].toString(16)} ≠ 0x${img[firstBad].toString(16)}` : '');
  ok(!sim.programWithoutErase, '没有出现"往未擦除区域写"（模拟目标会拒绝这种写）');
  ok(sim.progChunks === Math.ceil(img.length / flasher.chunkBytes),
     `编程分块数 = ${sim.progChunks}（每块 ${flasher.chunkBytes} B，尾部补 0xFF 到 4 字节）`);
  await flasher.verify(addr, img);
  ok(true, 'verify 逐字节读过一遍（读了 flash 再比，不是"假成功"）');

  // 负例：往**已经写过 0** 的区域再写 0xFF —— NOR 的编程是按位与，1 写不回去，
  // 硬件不报错，**校验时**必须露馅（这正是真机上"没擦就写"的表现）
  sim.flash.fill(0x00, 0x2000, 0x2010);
  sim.programWithoutErase = false;
  await flasher.program(board.flashBase + 0x2000, new Uint8Array(16).fill(0xff));
  ok(sim.programWithoutErase, '往"已是 0"的位写 1 → 模拟 flash 记录了"没擦就写"（按位与语义）');
  let verifyFailed = '';
  try { await flasher.verify(board.flashBase + 0x2000, new Uint8Array(16).fill(0xff)); }
  catch (e){ verifyFailed = e.message; }
  ok(/校验失败/.test(verifyFailed) && /读到 0x0/.test(verifyFailed),
     `校验把"没擦就写"抓出来了：${verifyFailed.slice(0, 66)}…`);

  // 已擦除的区域写 0x00 就应该成功（擦→写 的顺序正确时一切正常）
  sim.flash.fill(0xff, 0x3000, 0x3000 + 16);
  await flasher.program(board.flashBase + 0x3000, new Uint8Array(16));
  let wroteZero = true;
  for (let i = 0; i < 16; i++) if (sim.flash[0x3000 + i] !== 0) wroteZero = false;
  ok(wroteZero, '擦干净之后写 0x00 成功（擦→写 的顺序是对的）');
  await flasher.verify(board.flashBase + 0x3000, new Uint8Array(16));

  // 越界要拦在主机侧（用**板级窗口** flashSize，不是模拟 flash 的大小）
  let oob = false;
  try { await flasher.program(board.flashBase + board.flashSize, new Uint8Array(4)); }
  catch (e){ oob = /不合法|超出/.test(e.message); }
  ok(oob, `超出 flash 窗口（0x${(board.flashBase + board.flashSize).toString(16)}）的地址在主机侧就被拦住`);
  let oob2 = false;
  try { await flasher.erase(board.flashBase - 16, 32); } catch (e){ oob2 = /不合法|低于/.test(e.message); }
  ok(oob2, '低于 flash 基址的擦除范围也被拦住');

  await flasher.finish({ run: true });
  ok(!sim.halted, 'finish(run) 之后目标被放跑（ndmreset 脉冲 + 不置 haltreq）');
}

// ------------------------------------------------------------------ 5
console.log('== 5. 板级参数与状态码文案 ==');
{
  ok(C.HPM_BOARDS.length >= 10, `${C.HPM_BOARDS.length} 块 HPM 板子的参数（来自 SDK 的 openocd cfg）`);
  const b = C.hpmBoard('hpm6800evk');
  const a = C.hpmInitArgs(b, { 0: 0xFCF90000, 1: 0xFCF90001, 2: 0xFCF90002 });
  ok(a.header === 0xFCF90001 && a.words === 1, `header 编码 = words(1) | tag(0xfcf90)<<12 = 0x${a.header.toString(16)}`);
  const b2 = C.hpmInitArgs(C.hpmBoard('hpm5300evk'), { 0: 0, 1: 0xFCF90001, 2: 0xFCF90002 });
  ok(b2.words === 2 && b2.header === 0xFCF90002 && b2.option1 === 0x1000,
     'HPM5300 带两个 option 字（cfg 里给了 0x5 + 0x1000）');
  const b3 = C.hpmInitArgs(C.hpmBoard('hpm6300evk'), { 0: 0xFCF90000, 1: 0xFCF90001, 2: 0xFCF90002 });
  ok(b3.words === 0 && b3.header === 0xFCF90000, 'HPM6300 的 cfg 没给 option → words=0');
  ok(eq(C.hpmCheckRange(b, b.flashBase, 1024), { ok: true }) &&
     C.hpmCheckRange(b, b.flashBase + b.flashSize, 4).ok === false,
     '范围检查：窗口内放行 / 越过窗口拒绝');
  ok(C.HPM_COMMON.tapIdcode === 0x1000563D && C.HPM_COMMON.irLength === 5 && C.HPM_COMMON.romApiTable === 0x2001FF00,
     '全系通用常量：IDCODE / IRLEN=5 / ROM API 表 0x2001FF00（所以一份 blob 通吃）');
  ok(/成功/.test(hpmStatusText(0)) && /越界/.test(hpmStatusText(2)), `状态码文案：0→${hpmStatusText(0)} / 2→${hpmStatusText(2)}`);
  // 下拉里的 HPM id 与 HPM_BOARDS 必须一一对应（烧录页靠 id 分派到 RISC-V 那条路）
  const { CHIPS } = await import(url('app/core/chips.js'));
  const chipIds = CHIPS.map(c => c.v).filter(v => v.startsWith('hpm'));
  const boardIds = C.HPM_BOARDS.map(b => b.id);
  ok(chipIds.length === boardIds.length && boardIds.every(id => chipIds.includes(id)),
     `芯片下拉里的 ${chipIds.length} 个 HPM 项与 HPM_BOARDS 的 id 完全一致`);
}

// ------------------------------------------------------------------ 6
console.log('== 6. DAP 封包/解包（照探针固件 DAP.c 的 DAP_JTAG_Sequence）==');
{
  const D = await import(url('app/flash/hpm/dap-transport.js'));
  const seqs = [...J.tapReset(), ...J.tapLoadIR(0x11)];
  const packed = D.packJtagSequences(seqs);
  ok(packed[0] === seqs.length, `请求第 0 字节 = 序列条数（${packed[0]}）`);
  // 逐条核对布局：info + ceil(拍/8) 字节 TDI（TMS=1 的序列也带 TDI —— 固件无条件取走）
  let o = 1, layoutOk = true;
  for (const s of seqs){
    if (packed[o] !== s.info) layoutOk = false;
    o += 1 + s.tdi.length;
  }
  ok(layoutOk && o === packed.length, `封包布局 = [条数, (info, TDI)×n]，恰好 ${packed.length} B`);
  // 解析：只有带捕获位的序列回数据，顺序与请求一致（用真带捕获的 DR 扫描，别用全无捕获的复位序列）
  const raw = J.drScan(41, 0n, { idle: 7 });
  const captured = raw.filter(s => s.captureBytes > 0);
  ok(captured.length === 2, `DR 扫描里有 ${captured.length} 条序列要捕获 TDO（40 位 + 1 位）`);
  const body = new Uint8Array(1 + captured.reduce((n, s) => n + s.tdi.length, 0));
  body[0] = 0x00;
  let w = 1;
  for (const s of captured){ body.fill(0xa5, w, w + s.tdi.length); w += s.tdi.length; }
  const parsed = D.parseJtagSequenceResponse(body, raw);
  ok(parsed.length === captured.length &&
     parsed[0].length === captured[0].tdi.length && parsed[1].length === 1 &&
     parsed.every(b => b.every(x => x === 0xa5)),
     `解包里只挑"要捕获"的序列并按序返回（${parsed.map(b => b.length).join('+')} B）`);
  // 状态非 OK 要报错
  let threw = false;
  try { D.parseJtagSequenceResponse(Uint8Array.of(0xff), raw); } catch { threw = true; }
  ok(threw, 'DAP_JTAG_Sequence 返回非 OK 状态 → 抛错（不静默继续）');
  ok(D.setOutputModeData(1).join(',') === '1,1,0,1,0,196,12',
     'output_mode 切换报文的字节与 akaLinkPro 的 hpm6800_probe.py set-mode 一致');
  ok(D.PROBE_OUTPUT_MODE.SWD_JTAG === 1 && D.PROBE_OUTPUT_MODE.SWD_VCOM === 0, 'output_mode 取值：0=SWD+VCOM / 1=SWD+JTAG');
}

// ------------------------------------------------------------------ 7
console.log('== 7. 出错路径要"说人话"（真机 bring-up 时靠这些定位）==');
{
  const sim = new SimTarget();
  const dm = new RiscvTransport(sim, { idle: 7 });
  await dm.init();
  // 没 activate 就 halt：模拟目标 dmstatus 初始就是 allhalted，这里换个方式：让 abort 超时
  const flasher = new HpmFlasher(dm, { board: C.hpmBoard('hpm6800evk') });
  let msg = '';
  try { await flasher.erase(0x80000000, 4096); } catch (e){ msg = e.message; }
  ok(/先 setup/.test(msg), `没 setup 就擦除 → 明确提示先初始化：「${msg}」`);
  // blob 被截断（模拟"算法没搬全"）
  const short = hpmAlgoBytes().subarray(0, 20);
  ok(E.algoEntries(short).count < 7, 'blob 被截断时入口表也认不满 7 个（setup 会报错而不是硬跑）');
  // 状态码文案覆盖
  ok(/flash 未初始化/.test(hpmStatusText(5)), '返回码 5 = flash 未初始化（XPI 没配起来时的典型值）');
}

console.log(`\n${fail ? '❌' : '✅'} hpm-flash.test: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
