/**
 * RISC-V「复位并跑」的顺序回归（纯 Node，不碰硬件）。
 *
 * 2026-10 真机现场（HPM6800EVK + tcpecho）：先 `b main`、再点「复位并跑」→
 *   `复位后重新下发断点失败：抽象命令出错（cmderr=4，abstractcs=0x80004004）`
 * 根因是老 `resetRun()` 在 **ndmreset 还按着**的时候就写触发器 —— 核在复位态、dmstatus 不报
 * halted，抽象命令一律 cmderr=4。正确顺序是（`riscv-dm.js` 的 `_haltByReset` 就是这么做的）：
 *   按住 ndmreset+haltreq → **放开 ndmreset、保持 haltreq** → 等真的 halted → 写触发器 → 放 haltreq。
 *
 * 这个用例把顺序钉死：任何人再把触发器写到"放开复位之前"，这里立刻红。
 */
import assert from 'node:assert/strict';
import { RiscvDebugSession } from '../../app/dbg/riscv.js';
import { DMCONTROL } from '../../app/flash/hpm/jtag.js';

const seq = [];
const dm = {
  _ctl: (hart, extra = 0) => ((DMCONTROL.dmactive | DMCONTROL.hartsel(hart) | extra) >>> 0),
  /** 真流程里这一步会「按住 ndmreset+haltreq → 放开 ndmreset 保持 haltreq → 复验 → waitHalted」*/
  async _haltByReset(hart){ seq.push(`haltByReset:${hart}`); },
  async dmiWrite(a, v){ seq.push(`dmiWrite:0x${(a >>> 0).toString(16)}=0x${(v >>> 0).toString(16)}`); },
  async dmiRead(a){ seq.push(`dmiRead:0x${(a >>> 0).toString(16)}`); return 0; },
  async writeReg(r, v){ seq.push(`writeReg:0x${(r >>> 0).toString(16)}=0x${(v >>> 0).toString(16)}`); },
  async readReg(r){ seq.push(`readReg:0x${(r >>> 0).toString(16)}`); return 0x21800000; },
};

const s = Object.create(RiscvDebugSession.prototype);
Object.assign(s, {
  dm, halted: true, bps: [0x8000790c], bpNotes: new Map(),
  caps: { numCode: 2 }, pc: 0, _log(){},
  refresh: async () => {}, refreshRegs: async () => {},
});

await s.resetRun();

const iHalt = seq.findIndex(x => x.startsWith('haltByReset'));
const iTrig = seq.findIndex(x => x.startsWith('writeReg:0x7a0'));           // tselect
const last = seq.filter(x => x.startsWith('dmiWrite:0x10=')).pop() || '';
const lastVal = parseInt(/=0x([0-9a-f]+)$/.exec(last)?.[1] || '0', 16);   // 十六进制，别用 Number()

assert.ok(iHalt >= 0, '必须走 dm._haltByReset（复位 + 放开 ndmreset + 等停住）');
assert.ok(iTrig > iHalt, `触发器要在"放开复位并停住"之后才写（实到：${JSON.stringify(seq)}）`);
assert.equal(lastVal & DMCONTROL.haltreq, 0, '收尾那次 dmcontrol 不能留着 haltreq');
/**
 * 🚨 收尾必须是 **resumereq**，不能只是"清 haltreq"（2026-10 真机实测）：
 *    复位流程是"按下复位 → 停住（haltreq）→ 写触发器 → 放开"，这一步核是**被 haltreq 停住的**，
 *    而 RISC-V 里清 haltreq **不会**让它跑起来 —— 只有写 resumereq 才会。
 *    实测症状：只清 haltreq 时核一直停在复位向量（dpc=0x80003000=_start、dcsr.cause=3=haltreq）。
 */
assert.ok(lastVal & DMCONTROL.resumereq, '收尾必须 resumereq（清 haltreq 不会让核跑起来）');
assert.equal(s.halted, false, 'resetRun 结束后页面状态是"运行中"');

console.log('dbg-riscv-reset: 复位并跑 = 先放开复位并停住 → 再写触发器 → 再放 haltreq（顺序钉死）PASS');
