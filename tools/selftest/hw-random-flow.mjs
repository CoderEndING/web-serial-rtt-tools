/**
 * F103CB 多轮随机场景编排。
 *
 * 每个 feature 场景都包含：烧录狂发固件、RTT Viewer、60 MHz RTT 转发与 10 s
 * 记录、烧录 scope 固件，以及 J-Scope 的 1/3 变量 × 2/20 µs 四组采样。
 * debug 场景则重新烧录调试靶子并执行完整的真机调试压测（含 bt / DWT）。
 * 场景顺序由固定种子打乱，便于复现；每一轮都会明确记录实际顺序和结果。
 *
 *   node tools/selftest/hw-random-flow.mjs --seed=20261005 --rounds=3
 *   node tools/selftest/hw-random-flow.mjs --seed=7 --rounds=4 --keep-going
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const p = process.argv.find(x => x.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : fallback;
};
const has = name => process.argv.includes(`--${name}`);
const BOARD = String(arg('board', 'f103cb'));
const SEED = Number(arg('seed', '20261005')) >>> 0;
const ROUNDS = Math.max(1, Math.min(8, Number(arg('rounds', '3')) || 3));
const KEEP_GOING = has('keep-going');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG = resolve(ROOT, 'tmp', `hw-random-flow-${stamp}.log`);
mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
writeFileSync(LOG, `seed=${SEED} board=${BOARD} rounds=${ROUNDS}\n`);

function rand(state){
  // xorshift32：固定种子、无外部随机源，报告可以完全复现。
  let x = state.value >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  state.value = x >>> 0;
  return state.value;
}
function shuffle(list, state){
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--){
    const j = rand(state) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const state = { value: SEED || 1 };
const base = Array.from({ length: ROUNDS }, (_, i) => ({
  kind: i === 0 ? 'feature' : (i === 1 ? 'debug' : 'feature'),
  cycles: 1,
  alt: i === 0 ? 1 : 0,
}));
for (const item of base){
  // 后续 feature 场景随机加入一次狂发↔scope 交替烧录，避免每轮都只有同一顺序。
  if (item.kind === 'feature' && rand(state) % 2) item.alt = 1;
}
const plan = shuffle(base, state).map((x, i) => ({ ...x, step: i + 1 }));
const report = { startedAt: new Date().toISOString(), board: BOARD, seed: SEED, rounds: ROUNDS, log: LOG, plan, results: [] };
console.log(`== F103CB 随机场景压力 == seed=${SEED} · ${ROUNDS} 轮`);
console.log('计划：' + plan.map(x => `${x.step}:${x.kind}(cycles=${x.cycles},alt=${x.alt})`).join(' → '));

function run(command, args){
  return new Promise(resolveRun => {
    const started = Date.now();
    console.log(`\n--- 场景 ${command} ${args.join(' ')} ---`);
    appendFileSync(LOG, `\n$ ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { process.stdout.write(b); appendFileSync(LOG, b); });
    child.stderr.on('data', b => { process.stderr.write(b); appendFileSync(LOG, b); });
    child.on('error', error => resolveRun({ code: 1, error: String(error), ms: Date.now() - started }));
    child.on('exit', (code, signal) => resolveRun({ code: code ?? 1, signal, ms: Date.now() - started }));
  });
}

function nodeArgs(script, ...args){ return [script, ...args]; }
function featureArgs(item){
  return nodeArgs('tools/selftest/hw-campaign.mjs', `--board=${BOARD}`, '--local',
    `--cycles=${item.cycles}`, `--alt=${item.alt}`, '--keep-going');
}
function debugArgs(){
  return nodeArgs('tools/selftest/dbg-hw-stress.mjs', `--board=${BOARD}`, '--oracle=tmp/no-f103cb-oracle.json');
}

for (const item of plan){
  let r;
  if (item.kind === 'feature'){
    r = await run(process.execPath, featureArgs(item));
  } else {
    // 调试压测前必须换回 dbgstress 靶子；它自己通过页面烧录，随后仍在同一浏览器会话中测试。
    const flash = await run(process.execPath, nodeArgs('tools/selftest/flash-elf.mjs', `--board=${BOARD}`));
    if (flash.code !== 0){
      r = { code: flash.code, ms: flash.ms, error: '调试靶子烧录失败' };
    } else {
      r = await run(process.execPath, debugArgs());
    }
  }
  const result = { step: item.step, kind: item.kind, cycles: item.cycles, alt: item.alt, ...r };
  report.results.push(result);
  console.log(`--- 场景 ${item.step} ${item.kind}：${r.code === 0 ? 'PASS' : 'FAIL'} · ${(r.ms / 1000).toFixed(1)} s ---`);
  if (r.code !== 0 && !KEEP_GOING) break;
}

writeFileSync(resolve(ROOT, 'tmp', 'hw-random-flow-result.json'), JSON.stringify(report, null, 2));
console.log('\n================ 随机压力汇总 ================');
for (const r of report.results) console.log(`第 ${r.step} 步 ${r.kind}：${r.code === 0 ? 'PASS' : 'FAIL'} · ${(r.ms / 1000).toFixed(1)} s`);
console.log(`日志：${LOG}`);
console.log('结果：tmp/hw-random-flow-result.json');
process.exit(report.results.some(r => r.code !== 0) || report.results.length !== plan.length ? 1 : 0);
