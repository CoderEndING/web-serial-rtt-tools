/**
 * 纯 Node 自测（不需要浏览器、不需要硬件）：
 *   node tools/selftest/dwarf.test.mjs
 * 覆盖：ELF 容器（段表/符号表）+ DWARF 4 变量提取（类型映射、结构体展开、剔除原因）。
 *
 * 基线是 tools/fixtures/dwarf/ 里的**真 ELF 快照**（二进制入库，见那里的 README）。
 * 期望值是"变量契约"，不是"跑出来什么样" —— 地址对不上就是链接结果真的变了。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const app = join(root, 'app');
const url = p => 'file://' + join(app, p).replace(/\\/g, '/');
const fix = p => join(root, 'tools', 'fixtures', 'dwarf', p);

const { Elf, looksLikeElf } = await import(url('elf/elf.js'));
const { Dwarf, listSampleable, listFromSymtab, SCALARS, DEFAULT_RAM } = await import(url('elf/dwarf.js'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const load = p => new Elf(new Uint8Array(readFileSync(fix(p))));
const hex = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');

// ------------------------------------------------------------------ 1
console.log('== 1. ELF 容器 ==');
{
  const elf = load('stm32f103_scope.elf');
  ok(elf.bits === 32 && elf.le === true, '32 位 + 小端');
  ok(elf.section('.debug_info')?.size > 0, '.debug_info 存在');
  ok(elf.section('.debug_abbrev')?.size > 0, '.debug_abbrev 存在');
  ok(elf.section('.debug_str')?.size > 0, '.debug_str 存在');
  ok(!elf.has('.debug_str_offsets'), '没有 DWARF5 的 .debug_str_offsets（确认是 DWARF 4 的形态）');
  ok(elf.data('.debug_info').length === elf.section('.debug_info').size, 'data() 长度与段表一致');

  const syms = elf.symbols();
  const gp = syms.find(s => s.name === 'g_pack');
  ok(!!gp && gp.isObject, '符号表里有 g_pack 且是 OBJECT');
  ok(gp.addr === 0x20001014 && gp.size === 24, 'g_pack 地址/大小 = 0x20001014 / 24 B',
     `实际 ${hex(gp.addr)} / ${gp.size}`);
  ok(syms.some(s => s.name === 'g_vectors' && s.addr === 0x08000000), 'flash 里的 g_vectors 也在符号表里（后面要滤掉它）');

  // 坏了/不是 ELF 要明确报错，而不是解析出垃圾
  let threw = '';
  try { new Elf(new Uint8Array(200)); } catch (e){ threw = e.message; }
  ok(/不是 ELF|太小/.test(threw), '垃圾字节 → 明确抛错', threw);
  const trunc = new Uint8Array(64);
  trunc.set([0x7f, 0x45, 0x4c, 0x46, 1, 1]);
  threw = '';
  try { new Elf(trunc); } catch (e){ threw = e.message; }
  ok(/段表/.test(threw), '只有 ELF 头没有段表 → 明确抛错', threw);
  ok(looksLikeElf(readFileSync(fix('stm32f103_scope.elf'))) === true, 'looksLikeElf 认得真 ELF');
}

// ------------------------------------------------------------------ 2
console.log('== 2. DWARF：靶子固件的 19 个通道（结构体展开 + 类型映射）==');
{
  const elf = load('stm32f103_scope.elf');
  const r = listSampleable(elf);
  ok(r.source === 'dwarf', '走的是 DWARF 路径');
  ok(r.versions.length === 1 && r.versions[0] === 4, 'DWARF 版本 = 4');
  ok(r.stats.cu === 2, 'CU 数 = 2（main.c / startup.c）', `实际 ${r.stats.cu}`);
  ok(Dwarf.available(elf) === true, 'Dwarf.available 认得出调试信息');

  // 变量契约（地址/大小/类型），与 stm32f103_scope/src/main.c 的表一一对应
  const want = [
    ['g_lfsr',                 0x20000000, 4, 'u32'],
    ['g_far_cnt',              0x20000008, 4, 'u32'],
    ['g_far_sq100',            0x2000000c, 2, 'i16'],
    ['g_isr_count',            0x20001010, 4, 'u32'],
    ['g_pack.f_sin',           0x20001014, 4, 'f32'],
    ['g_pack.f_tri',           0x20001018, 4, 'f32'],
    ['g_pack.i_tick',          0x2000101c, 4, 'i32'],
    ['g_pack.u_ramp',          0x20001020, 2, 'u16'],
    ['g_pack.i_sq1k',          0x20001022, 2, 'i16'],
    ['g_pack.u_cnt',           0x20001024, 1, 'u8'],
    ['g_pack.i_saw',           0x20001025, 1, 'i8'],
    ['g_pack.rsv0',            0x20001026, 1, 'u8'],
    ['g_pack.u_hi',            0x20001028, 4, 'u32'],
    ['g_pair_a',               0x2000102c, 2, 'u16'],
    ['g_pair_b',               0x2000102e, 2, 'u16'],
    ['g_pulse',                0x20001030, 1, 'u8'],
    ['g_ramp64',               0x20001038, 8, 'f64'],
    ['g_sq5k',                 0x20001040, 2, 'i16'],
    ['g_tick',                 0x20001044, 4, 'u32'],
  ];
  const got = r.sampleable.map(v => [v.name, v.addr, v.size, v.scalar]);
  ok(got.length === want.length, `可采样通道数 = ${want.length}`, `实际 ${got.length}`);
  for (const [nm, addr, size, sc] of want){
    const hit = r.sampleable.find(v => v.name === nm);
    ok(!!hit && hit.addr === addr && hit.size === size && hit.scalar === sc,
       `${nm.padEnd(18)} ${hex(addr)} ${size}B ${sc}`,
       hit ? `实际 ${hex(hit.addr)} ${hit.size}B ${hit.scalar}` : '没找到');
  }
  // 结构体成员必须都带上"哪来的"
  ok(r.sampleable.filter(v => v.group === 'g_pack').length === 9, 'g_pack 展开出 9 个成员（含保留字节 rsv0）');
  ok(r.sampleable.every(v => v.path === v.name), '每个通道都带完整路径（g_pack.f_sin）');

  // 采不了的要**带原因**
  const hole = r.skipped.find(s => s.name === 'g_hole');
  ok(!!hole && /数组/.test(hole.reason), 'g_hole（4096 B 数组）被剔除并说明是数组', hole?.reason);
  ok(!r.sampleable.some(v => v.name.startsWith('g_hole')), 'g_hole 不在可采样列表里');
  ok(r.sampleable.every(v => v.addr >= DEFAULT_RAM[0] && v.addr < DEFAULT_RAM[1]), '所有通道都落在 RAM 窗口内');
  ok(!r.sampleable.some(v => /SIN100|g_vectors/.test(v.name)), 'rodata（SIN100）与向量表（g_vectors）都被滤掉');

  // 类型表与 HID 0x32 的编码一致
  ok(SCALARS.f32.code === 6 && SCALARS.f64.code === 7 && SCALARS.u8.code === 0, 'SCALARS 的 code 与协议表一致');
  ok(Object.keys(SCALARS).length === 8, '类型表 8 种（u8/i8/u16/i16/u32/i32/f32/f64）');
}

// ------------------------------------------------------------------ 3
console.log('== 3. 没有 DWARF 时的退化路径（符号表）==');
{
  const elf = load('stm32f103_scope.elf');
  const r = listFromSymtab(elf);
  ok(r.source === 'symtab', 'source = symtab');
  const gp = r.sampleable.find(v => v.name === 'g_pack');
  ok(!!gp && gp.addr === 0x20001014 && gp.size === 24 && gp.scalar === null,
     'g_pack 在列（24 B）但**类型未知**（要用户手选）');
  ok(r.skipped.some(s => s.name === 'g_vectors' && /RAM/.test(s.reason)), 'flash 里的符号被剔除并说明不在 RAM');
  ok(!r.sampleable.some(v => v.name === '_estack'), '_estack（栈顶符号）也被 RAM 窗口滤掉');
}

// ------------------------------------------------------------------ 4
console.log('== 4. 真工程风格：多 CU + typedef 结构体 + DW_AT_specification ==');
{
  const elf = load('stm32f103_rtt_speed.elf');
  const r = listSampleable(elf);
  ok(r.source === 'dwarf' && r.versions[0] === 4, 'DWARF 4，走 DWARF 路径');
  const want = [
    ['g_bytes',                      0x20000000, 'u32'],
    ['g_loops',                      0x20000004, 'u32'],
    ['g_ms',                         0x20000008, 'u32'],
    ['_SEGGER_RTT.MaxNumUpBuffers',  0x2000001c, 'i32'],
    ['_SEGGER_RTT.MaxNumDownBuffers', 0x20000020, 'i32'],
  ];
  for (const [nm, addr, sc] of want){
    const hit = r.sampleable.find(v => v.name === nm);
    ok(!!hit && hit.addr === addr && hit.scalar === sc, `${nm.padEnd(30)} ${hex(addr)} ${sc}`,
       hit ? `实际 ${hex(hit.addr)} ${hit.scalar}` : '没找到');
  }
  // 这一条是关键：定义 DIE 无名，名字/类型在"声明"那侧 —— 不追 specification 就整块漏掉
  ok(r.skipped.some(s => s.name === '_SEGGER_RTT.acID'), '追到了声明里的成员名（_SEGGER_RTT.acID）');
  ok(r.skipped.some(s => /_SEGGER_RTT\.aUp/.test(s.name)), '_SEGGER_RTT.aUp（数组）也带原因列出');
  ok(!r.skipped.some(s => /^\(无名变量/.test(s.name)), '没有"无名变量"这种漏网（说明 specification 追上了）');
}

// ------------------------------------------------------------------ 5
console.log('== 5. 稳健性：不崩、不乱、原因可读 ==');
{
  const elf = load('stm32f103_scope.elf');
  const r = listSampleable(elf);
  ok(r.skipped.every(s => typeof s.reason === 'string' && s.reason.length > 0), '每个被剔除的条目都有原因文案');
  ok(r.skipped.some(s => /位置列表|寄存器|栈帧/.test(s.reason)), '被优化掉的局部变量给出"没有固定地址"类原因');

  // 重复调用要给同样的结果（索引/缓存不能互相污染）
  const again = listSampleable(load('stm32f103_scope.elf'));
  ok(JSON.stringify(again.sampleable) === JSON.stringify(r.sampleable), '两次解析结果完全一致');

  // 自定义 RAM 窗口：把窗口收窄到一个不覆盖任何变量的区间 → 全部被剔除
  const narrow = listSampleable(load('stm32f103_scope.elf'), { ram: [0x30000000, 0x30001000] });
  ok(narrow.sampleable.length === 0 && narrow.skipped.some(s => /RAM 窗口/.test(s.reason)),
     'RAM 窗口可配置（收窄后全部剔除并说明原因）');
}

console.log(`\n${fail ? '❌' : '✅'} dwarf.test: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
