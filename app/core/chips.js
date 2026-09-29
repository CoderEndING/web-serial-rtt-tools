/**
 * 芯片预设表：烧录器与 RTT Viewer 共用的「芯片 → OpenOCD cfg / RAM 扫描范围」。
 * RTT 的下拉目前在 HTML 里手写（内容与此表一致），改这里记得同步那边。
 * ram 只给 STM32 系列（RTT 扫描范围用）；烧录不需要 ram，只认 v（bridge.config.json 的目标名）。
 */
export const CHIPS = [
  { v: 'stm32f103', label: 'STM32F1（F103 等）',  ram: '0x20000000-0x20005000' },
  { v: 'stm32f0',   label: 'STM32F0',             ram: '0x20000000-0x20002000' },
  { v: 'stm32f2',   label: 'STM32F2',             ram: '0x20000000-0x20020000' },
  { v: 'stm32f3',   label: 'STM32F3',             ram: '0x20000000-0x2000a000' },
  { v: 'stm32f4',   label: 'STM32F4',             ram: '0x20000000-0x20020000' },
  { v: 'stm32f7',   label: 'STM32F7',             ram: '0x20000000-0x20020000' },
  { v: 'stm32g0',   label: 'STM32G0',             ram: '0x20000000-0x20008000' },
  { v: 'stm32g4',   label: 'STM32G4',             ram: '0x20000000-0x20008000' },
  { v: 'stm32h7',   label: 'STM32H7',             ram: '0x20000000-0x20020000' },
  /**
   * H7B0 / H7A3 / H7B3（value line 那几颗）：内存是**散的**，扫描范围给两段 ——
   *   DTCM 0x20000000（128KB，内核直连；本仓库的 H7B0 测速固件就把 RTT 放这儿）
   *   AXI SRAM 0x24000000（1MB，H7B0 实际 1.4MB 的一部分）
   * 中间那些空洞（0x20020000~0x23FFFFFF 未映射）扫描时会读失败，locate 会自动跳过该段。
   */
  { v: 'stm32h7b0', label: 'STM32H7B0/H7A3/H7B3', ram: '0x20000000-0x20020000, 0x24000000-0x24100000' },
  { v: 'stm32h5',   label: 'STM32H5',             ram: '0x20000000-0x20020000' },
  { v: 'stm32l0',   label: 'STM32L0',             ram: '0x20000000-0x20005000' },
  { v: 'stm32l1',   label: 'STM32L1',             ram: '0x20000000-0x20004000' },
  { v: 'stm32l4',   label: 'STM32L4 / L4+',       ram: '0x20000000-0x2000c000' },
  { v: 'stm32l5',   label: 'STM32L5',             ram: '0x20000000-0x20010000' },
  { v: 'stm32u5',   label: 'STM32U5',             ram: '0x20000000-0x20020000' },
  { v: 'stm32c0',   label: 'STM32C0',             ram: '0x20000000-0x20003000' },
  { v: 'stm32wb',   label: 'STM32WB',             ram: '0x20000000-0x20040000' },
  { v: 'stm32wl',   label: 'STM32WL',             ram: '0x20000000-0x20010000' },
  { v: 'esp32s31',  label: 'ESP32-S31（板载 USB-JTAG）' },
  { v: 'esp32',     label: 'ESP32（Wrover Kit）' },
  /**
   * HPM 系列（RISC-V）：**零安装 WebUSB 烧录**走的是另一条路（JTAG + 芯片 ROM 里的 XPI 驱动），
   * 参数来自 HPM SDK 的 `boards/openocd/boards/*.cfg`（见 `app/flash/hpm/chips.js`）。
   * 这些 id 必须与 `HPM_BOARDS` 里的 id 一致 —— 烧录页靠它分派。
   * 本地桥（OpenOCD）也能烧：cfg 用 SDK 的 `hpm<xxxx>_all_in_one.cfg`。
   */
  { v: 'hpm5300evk',    label: 'HPM5300EVK（RISC-V，零安装）', ram: '0x00000000-0x00020000' },
  { v: 'hpm5301evklite', label: 'HPM5301EVKLite（RISC-V，零安装）', ram: '0x00000000-0x00020000' },
  { v: 'hpm5e00evk',    label: 'HPM5E00EVK（RISC-V，零安装）' },
  { v: 'hpm6200evk',    label: 'HPM6200EVK（RISC-V，零安装）' },
  { v: 'hpm6300evk',    label: 'HPM6300EVK（RISC-V，零安装）' },
  { v: 'hpm6750evk2',   label: 'HPM6750EVK2（RISC-V，零安装）' },
  { v: 'hpm6750evkmini', label: 'HPM6750EVKMINI（RISC-V，零安装）' },
  { v: 'hpm6800evk',    label: 'HPM6800EVK（RISC-V，零安装）', ram: '0x00000000-0x00020000' },
  { v: 'hpm6e00evk',    label: 'HPM6E00EVK（RISC-V，零安装）' },
  { v: 'hpm6p00evk',    label: 'HPM6P00EVK（RISC-V，零安装）' },
  { v: 'custom',    label: '自定义 cfg…' },
];

export function fillChipSelect(sel){
  for (const c of CHIPS) sel.appendChild(new Option(c.label, c.v));
}
