/**
 * HPM 系列（RISC-V）烧录参数 —— 数据全部来自 HPM SDK 的 OpenOCD 配置，别手抄。
 *
 * 出处（`E:\sdk_env_v1.11.0\hpm_sdk\boards\openocd\`）：
 *   · `boards/<board>.cfg` 的 `flash bank xpi0 hpm_xpi <base> <size> <cw> <bw> <target> <xpi_base> [opt0] [opt1]`
 *   · `soc/<soc>.cfg` 的 `jtag newtap … -irlen 5 -expected-id 0x1000563D`
 *     与 `configure -work-area-phys 0x00000000 -work-area-size 0x20000`
 *
 * 两个"全系通用"的事实（已在源码里核实）：
 *   · **TAP IDCODE / IRLEN 全系列相同**：0x1000563D / 5 位；
 *   · **ROM API 表地址全系列相同**：`ROM_API_TABLE_ROOT = 0x2001FF00`
 *     （见各 `soc/<family>/<part>/hpm_romapi.h`）—— 所以**一份 flashloader blob 通吃**，
 *     差异只在下面这些运行时参数里（`flash_init(flash_base, header, opt0, opt1, xpi_base)`）。
 *
 * `option0/option1` 的位含义见 `boards/hpm6800evk.cfg` 的注释（[31:28] 探测方式、
 * [27:24] 上电命令线数、[23:20] 配置后线数、[19:16] QE 位、[15:8] dummy、[3:0] 频率……）。
 */

/** RV32 flashloader 的入口签名（a0..a4 入参，a0 返回；细节见 tools/target-firmware/hpm_flash_algo/README.md）*/
export const HPM_ALGO_ABI = {
  init: '(flash_base, header, opt0, opt1, xpi_base)',
  erase: '(flash_base, address, size)',
  program: '(flash_base, address, buf, size)',
  read: '(flash_base, buf, address, size)',
  info: '(flash_base, info*)',
  eraseChip: '(flash_base)',
  deinit: '()',
};

/** 全系列共用的常量 */
export const HPM_COMMON = {
  tapIdcode: 0x1000563D,
  irLength: 5,
  /** flashloader 加载/运行区（SDK 的 work-area）：32 位地址空间从 0 起的 128 KB SRAM */
  workAreaAddr: 0x00000000,
  workAreaSize: 0x20000,
  /** flashloader 调用的 ROM API 表（全系列同一地址）*/
  romApiTable: 0x2001FF00,
  /** XPI0 / XPI1 的存储器映射窗口 */
  xpi0Base: 0x80000000,
  xpi1Base: 0x90000000,
};

/**
 * 每块板的烧录参数。
 * `option1: null` 表示 OpenOCD 配置里没给第二个 option 字（header.words = 1）。
 */
export const HPM_BOARDS = [
  { id: 'hpm5300evk',   name: 'HPM5300EVK（HPM5361）',  family: 'HPM5300', flashBase: 0x80000000, flashSize: 0x2000000, xpiBase: 0xF3000000, option0: 0x5, option1: 0x1000 },
  { id: 'hpm5301evklite', name: 'HPM5301EVKLite',       family: 'HPM5301', flashBase: 0x80000000, flashSize: 0x2000000, xpiBase: 0xF3000000, option0: 0x5, option1: 0x1000 },
  { id: 'hpm5e00evk',   name: 'HPM5E00EVK',             family: 'HPM5E00', flashBase: 0x80000000, flashSize: 0x2000000, xpiBase: 0xF3000000, option0: 0x5, option1: 0x1000 },
  { id: 'hpm6200evk',   name: 'HPM6200EVK（HPM6280）',  family: 'HPM6200', flashBase: 0x80000000, flashSize: 0x1000000, xpiBase: 0xF3040000, option0: null, option1: null },
  { id: 'hpm6300evk',   name: 'HPM6300EVK（HPM6360）',  family: 'HPM6300', flashBase: 0x80000000, flashSize: 0x1000000, xpiBase: 0xF3040000, option0: null, option1: null },
  { id: 'hpm6750evk2',  name: 'HPM6750EVK2',            family: 'HPM6750', flashBase: 0x80000000, flashSize: 0x2000000, xpiBase: 0xF3040000, option0: 0x7, option1: null },
  { id: 'hpm6750evkmini', name: 'HPM6750EVKMINI',       family: 'HPM6750', flashBase: 0x80000000, flashSize: 0x1000000, xpiBase: 0xF3040000, option0: 0x7, option1: null },
  { id: 'hpm6800evk',   name: 'HPM6800EVK（HPM6880）',  family: 'HPM6880', flashBase: 0x80000000, flashSize: 0x2000000, xpiBase: 0xF3000000, option0: 0x7, option1: null },
  { id: 'hpm6e00evk',   name: 'HPM6E00EVK（HPM6E80）',  family: 'HPM6E80', flashBase: 0x80000000, flashSize: 0x2000000, xpiBase: 0xF3000000, option0: 0x7, option1: null },
  { id: 'hpm6p00evk',   name: 'HPM6P00EVK（HPM6P81）',  family: 'HPM6P81', flashBase: 0x80000000, flashSize: 0x2000000, xpiBase: 0xF3000000, option0: 0x5, option1: 0x1000 },
];

/** 按 id 取板级参数 */
export const hpmBoard = id => HPM_BOARDS.find(b => b.id === id) || null;

/**
 * 组装 `flash_init` 的参数。
 * `header` 的编码：`words(4bit) | tag(0xfcf90) << 12`（见 SDK `xpi_nor_config_option_t`），
 * words = 实际给出的 option 字数（0/1/2）—— 与 OpenOCD 驱动把 cfg 里几个 option 透传下来一致。
 */
export function hpmInitArgs(board, headerConstants){
  const words = board.option1 != null ? 2 : (board.option0 != null ? 1 : 0);
  const H = headerConstants || { 0: 0xFCF90000, 1: 0xFCF90001, 2: 0xFCF90002 };
  return {
    flashBase: board.flashBase >>> 0,
    header: (H[words] ?? (words | (0xfcf90 << 12))) >>> 0,
    option0: (board.option0 ?? 0) >>> 0,
    option1: (board.option1 ?? 0) >>> 0,
    xpiBase: board.xpiBase >>> 0,
    words,
  };
}

/**
 * 范围检查（纯函数，自测里钉住）：允许写入的窗口 = [flashBase, flashBase + flashSize)。
 * `flashSize` 用的是 SDK cfg 里的探测上限；**真实容量**由 `flash_get_info` 在运行时读回，
 * 两者不一致时以芯片回报的为准（见 flash.js 的 `probe()`）。
 */
export function hpmCheckRange(board, addr, len){
  const start = board.flashBase >>> 0;
  const end = start + (board.flashSize >>> 0);
  const a = addr >>> 0, b = (addr + len) >>> 0;
  if (b <= a) return { ok: false, why: '长度为零或地址回绕' };
  if (a < start) return { ok: false, why: `地址 0x${a.toString(16)} 低于 flash 基址 0x${start.toString(16)}` };
  if (b > end) return { ok: false, why: `末端 0x${b.toString(16)} 超出 ${(board.flashSize / 1048576).toFixed(0)} MB 窗口` };
  return { ok: true };
}
