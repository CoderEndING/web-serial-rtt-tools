/**
 * 离线核对：每个芯片算法的 chunkSize()（编程分块）与擦除/编程计划是否合理。
 * 不连硬件 —— 专门用来在没有板子的时候把"参数级"错误挑出来。
 * 用法：node tools/dev/check-flash-plan.mjs [firmware.elf|.hex|.bin ...]
 */
import { ALGOS } from '../../app/flash/algos.js';
import { FlashRunner } from '../../app/flash/runner.js';
import { parseFirmware } from '../../app/flash/image.js';
import fs from 'node:fs';
import path from 'node:path';

const runner = new FlashRunner({});
console.log('=== chunkSize（单次编程块）与页参数对照 ===');
let bad = 0;
for (const [name, algo] of Object.entries(ALGOS)){
  runner.algo = algo;
  const chunk = runner.chunkSize();
  const wg = algo.write_granularity || 4;
  const gap = algo.page_buffers.length > 1 ? algo.page_buffers[1] - algo.page_buffers[0] : 0;
  const problems = [];
  if (chunk > algo.page_size) problems.push(`块(${chunk}) > 擦除粒度(${algo.page_size})`);
  if (chunk % wg) problems.push(`块(${chunk}) 不是编程粒度(${wg})的整数倍`);
  if (chunk < 4) problems.push('块太小');
  if (chunk % 4) problems.push('块不是 4 的倍数（算法按字写）');
  console.log(`  ${name.padEnd(11)} 擦除粒度 ${String(algo.page_size).padStart(7)} B · 编程粒度 ${String(wg).padStart(2)} B · ` +
    `缓冲 ${algo.page_buffers.length} 个${gap > 0 ? `(间距 ${gap})` : '(单缓冲)'} → chunk ${chunk} B${problems.length ? '  ❌ ' + problems.join('; ') : '  ✅'}`);
  if (problems.length) bad++;
}

// 有固件文件的话，把"擦除计划 + 编程分块（含尾块补齐）"也跑一遍（纯计算，不碰硬件）
for (const file of process.argv.slice(2)){
  if (!fs.existsSync(file)){ console.log(`\n${file}: 不存在`); continue; }
  const algoName = /h7b0/i.test(file) ? 'stm32h7b0' : 'stm32f103';
  const algo = ALGOS[algoName];
  runner.algo = algo;
  const u8 = new Uint8Array(fs.readFileSync(file));
  const regions = parseFirmware(path.basename(file), u8, 0x08000000);
  const chunk = runner.chunkSize();
  const wg = algo.write_granularity || 4;
  let eraseCount = 0, progCalls = 0, lastData = 0;
  for (const seg of regions){
    const ps = algo.page_size;
    for (let a = algo.flash_start + Math.floor((seg.addr - algo.flash_start) / ps) * ps; a < seg.addr + seg.data.length; a += ps) eraseCount++;
    for (let off = 0; off < seg.data.length; off += chunk){
      let len = Math.min(chunk, seg.data.length - off);
      if (len % wg) len = Math.ceil(len / wg) * wg;      // 尾块补 0xFF（与 view.js 同规则）
      progCalls++; lastData = len;
    }
  }
  const total = regions.reduce((s, r) => s + r.data.length, 0);
  const inRange = regions.every(r => r.addr >= algo.flash_start && r.addr + r.data.length <= algo.flash_start + algo.flash_length);
  console.log(`\n=== ${path.basename(file)} → ${algoName} ===`);
  console.log(`  段      : ${regions.map(r => '0x' + r.addr.toString(16) + '+' + r.data.length).join(', ')}`);
  console.log(`  擦除    : ${eraseCount} 次（每次 ${algo.page_size} B）`);
  console.log(`  编程    : ${progCalls} 次（每块 ≤ ${chunk} B，尾块补到 ${wg} 的倍数后最大 ${lastData} B）`);
  console.log(`  校验    : 读回 ${total} B 逐字节比对`);
  console.log(`  范围    : ${inRange ? '✅ 全在 flash 范围内' : '❌ 有段越界'}`);
  if (!inRange) bad++;
}

console.log(bad ? `\n结论：有 ${bad} 处问题 ❌` : '\n结论：全部自洽 ✅');
process.exit(bad ? 1 : 0);
