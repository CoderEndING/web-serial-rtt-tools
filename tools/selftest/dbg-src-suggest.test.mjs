/**
 * 「载入 ELF 就推荐源码目录」（`sourceRootSuggestions`）的纯函数回归。
 *
 * 为什么值得钉：这份 HPM6800EVK 的 ELF 里，188 条 DWARF 路径**全是绝对路径**，且分三簇 ——
 * `E:/sdk_env_v1.11.0/hpm_sdk` 146 条、`E:/sdk_env_v1.11.0/toolchains` 18 条、
 * `/home/builder/...` 24 条（编译机路径，本机覆盖不到）。推荐逻辑要：
 *   ① 沿最大分支往下钻到一个"够用又不至于太大"的目录；② 把跨机器的簇标出来，别让用户白选。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceRootSuggestions } from '../../app/dbg/source.js';
import { SymTab } from '../../app/dbg/symbols.js';

// ---------- ① 合成：主簇里没有绝对多数分支 → 就停在簇根
{
  const gen = (n, sub) => Array.from({ length: n }, (_, i) => `E:/proj/sdk/${sub}/f${i}.c`);
  const paths = [...gen(40, 'core'), ...gen(30, 'drivers'), ...gen(20, 'middleware'),
                 ...Array.from({ length: 10 }, (_, i) => `/home/builder/work/g${i}.c`)];
  const s = sourceRootSuggestions(paths);
  assert.equal(s.total, 100, '总数');
  assert.equal(s.best.dir, 'E:/proj/sdk', '没有绝对多数分支时就停在簇根');
  assert.equal(s.best.files, 90, '覆盖数 = 主簇文件数');
  assert.equal(s.others.length, 1, '另一簇要列出来');
  assert.equal(s.others[0].dir, '/home/builder/work');
  assert.equal(s.others[0].foreign, true, '跨机器（win vs posix）要标 foreign');
}

// ---------- ② 合成：某个孩子占绝对多数 → 往下钻（推荐更具体的目录）
{
  const gen = (n, sub) => Array.from({ length: n }, (_, i) => `E:/proj2/app/${sub}/f${i}.c`);
  const paths = [...gen(60, 'src/core'), ...gen(20, 'src/drv'), ...gen(10, 'inc')];
  const s = sourceRootSuggestions(paths);
  assert.equal(s.best.dir, 'E:/proj2/app/src', '80/90 超过 60%，应当从 app 钻到 src');
  assert.equal(s.best.files, 80);
}

// ---------- ③ 大小写不敏感去重（Windows 路径）
{
  const s = sourceRootSuggestions(['E:/Proj/src/a.c', 'e:/proj/src/A.C', 'E:/proj/src/b.c']);
  assert.equal(s.total, 2, '同一文件的大小写变体只算一次');
}

// ---------- ④ 空 / 无绝对路径
{
  assert.equal(sourceRootSuggestions([]).total, 0);
  assert.equal(sourceRootSuggestions(['a.c', './b.c']).total, 0, '相对路径不算');
}

// ---------- ⑤ 真 ELF（仓库里的 fixture）：主簇取到最多文件，别的簇列出来
{
  const st = SymTab.fromBuffer(readFileSync('tools/fixtures/dwarf/stm32f103_rtt_speed.elf'));
  const s = sourceRootSuggestions(st.lines?.paths || []);
  assert.ok(s.total > 0 && s.best, 'fixture ELF 应当能给出建议');
  assert.ok(s.best.files >= s.total / 2, `推荐目录要覆盖多数文件（实到 ${s.best.files}/${s.total}）`);
  assert.equal(s.best.dir.split('/').slice(0, 2).join('/').toLowerCase(),
               s.root.dir.toLowerCase(), '推荐目录必须落在主簇里');
}

console.log('dbg-src-suggest: 首选目录（沿最大分支钻）/ 跨机器簇标记 / 大小写去重 / 真 ELF PASS');
