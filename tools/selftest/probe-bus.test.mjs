/**
 * 跨页签探针协调（`app/core/probe-bus.js`）的自测 —— 纯离线，用 Node 自带的 BroadcastChannel
 * 起两个"页签"互相喊话，不需要浏览器，也不需要硬件。
 *   node tools/selftest/probe-bus.test.mjs      （等价：make test-probe-bus）
 *
 * 为什么值得有：这一层是"两个标签页抢同一台探针 → 认领接口失败 → 烧录直接卡住"的唯一解法。
 * 要钉住的语义有四条：
 *   ① 喊一嗓子之后，另一个"页签"真的会执行让出动作，并且回执给请求方；
 *   ② 没有同伴时不干等（< settle 窗口就返回）；
 *   ③ 同伴磨蹭时请求方也不会等过头（有 waitMs 上限）；
 *   ④ 环境里没有 BroadcastChannel 时静默降级，绝不让协调层变成新的失败点。
 */
import { ProbeBus, PROBE_BUS_CHANNEL } from '../../app/core/probe-bus.js';

setTimeout(() => { console.error('[WATCHDOG] 总超时'); process.exit(9); }, 20000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

console.log('目标: ' + PROBE_BUS_CHANNEL + '（Node 的 BroadcastChannel，进程内等价"同源页签"）');

console.log('\n── 1. 请求让出 → 对方执行并回执 ──');
{
  const a = new ProbeBus('A'), b = new ProbeBus('B');
  let released = 0, why = null;
  b.onRelease = w => { released++; why = w; };
  await sleep(120);                                   // 让 hello/here 握手完成
  const r = await a.requestRelease({ why: '烧录 demo.elf' });
  ok(released === 1, `对方执行了让出动作（${released} 次）`);
  ok(why === '烧录 demo.elf', `理由原样传过去：「${why}」`);
  ok(r.supported === true, '报告"协调可用"');
  ok(r.asked === 1, `认识 1 个同伴（asked=${r.asked}）`);
  ok(r.acked === 1, `收到 1 个回执（acked=${r.acked}）`);
  ok(r.ms < 1200, `没等到上限就返回（${r.ms} ms）`);
  a.close(); b.close();
}

console.log('\n── 2. 没有同伴：不干等 ──');
{
  const a = new ProbeBus('A2');
  await sleep(300);                                   // 等一会儿确认确实没人应答
  const r = await a.requestRelease({ why: '烧录' });
  ok(r.asked === 0 && r.acked === 0, `没人应答（asked=${r.asked} acked=${r.acked}）`);
  ok(r.ms < 600, `只在 settle 窗口里等（${r.ms} ms，不占满 waitMs=1200）`);
  a.close();
}

console.log('\n── 3. 同伴磨蹭：请求方有上限，不会被拖住 ──');
{
  const a = new ProbeBus('A3'), b = new ProbeBus('B3');
  b.onRelease = () => sleep(3000);                    // 故意磨蹭 3 s
  await sleep(120);
  const t0 = Date.now();
  const r = await a.requestRelease({ why: '烧录', waitMs: 600 });
  const dt = Date.now() - t0;
  ok(dt < 1100, `请求方 ${dt} ms 就回来了（waitMs=600，不被对方的 3 s 拖住）`);
  ok(r.acked === 0, '没拿到回执也如实报告（acked=0）');
  a.close(); b.close();
}

console.log('\n── 4. 让出动作抛异常：不能把请求方带崩 ──');
{
  const a = new ProbeBus('A4'), b = new ProbeBus('B4');
  b.onRelease = () => { throw new Error('让出失败（模拟）'); };
  await sleep(120);
  const r = await a.requestRelease({ why: '烧录' });
  ok(r.acked === 1, '对方抛异常也照样回执（请求方关心的是"你还占不占着"）');
  await sleep(50);
  ok(true, '请求方没有异常');
  a.close(); b.close();
}

console.log('\n── 5. 环境里没有 BroadcastChannel：静默降级 ──');
{
  const saved = globalThis.BroadcastChannel;
  try {
    delete globalThis.BroadcastChannel;
    const a = new ProbeBus('A5');
    ok(a.supported === false, '认得出环境不支持');
    const r = await a.requestRelease({ why: '烧录' });
    ok(r.supported === false && r.asked === 0, '返回"不支持"，不抛错、不等待');
  } finally {
    globalThis.BroadcastChannel = saved;
  }
}

console.log(`\n${fail ? '❌' : '✅'} probe-bus：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
