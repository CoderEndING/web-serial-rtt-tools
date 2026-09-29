# HPM 系列 flashloader（RV32 烧录算法）

网页端 `烧录器` 页的 **HPM RISC-V WebUSB 烧录**用它：把这段算法经调试链路写进目标 SRAM，
再依次调用它的入口（`flash_init` → `flash_erase` → `flash_program` → 校验 → 复位运行）。

## 出处与许可

- `openocd_flash_algo.c` / `func_table.S` / `linker.ld`：**原样**取自 HPMicro HPM SDK
  `samples/openocd_algo/src/`（BSD-3-Clause，Copyright (c) 2021 HPMicro）。本仓库 Apache-2.0，
  BSD-3 兼容；文件头的版权声明保留。
- `memset.c`：本仓库自己写的极小替身（见文件内注释）。

## 为什么能"一套算法通吃 HPM 全系"

算法不直接操作 XPI 寄存器，而是调用**芯片 ROM 里的 XPI NOR 驱动**
（`ROM_API_TABLE_ROOT->xpi_nor_driver_if`）。实测（`soc/*/*/hpm_romapi.h`）**所有 HPM 系列**
的 `ROM_API_TABLE_ROOT` 都是 `0x2001FF00`，所以同一份 blob 在 5300/5E00/6200/6300/6700/6800/
6E00/6P00 上都成立 —— 差异只在**运行时参数**：`flash_base`、`xpi_base`、`option0/1`
（见 `app/flash/hpm/chips.js`，数据来自 SDK 的 `boards/openocd/boards/*.cfg` 的 `flash bank` 行）。

## 入口表（`func_table.S`，位于 blob 偏移 0，每项 8 B：`jal 函数` + `ebreak`）

| # | 偏移 | 函数 | 签名（RV32 调用约定，a0..a4 入参 / a0 返回） |
| - | ---- | ---- | ------------------------------------------- |
| 0 | 0x00 | `flash_init` | `(flash_base, header, opt0, opt1, xpi_base) -> status` |
| 1 | 0x08 | `flash_erase` | `(flash_base, address, size) -> status` |
| 2 | 0x10 | `flash_program` | `(flash_base, address, buf, size) -> status` |
| 3 | 0x18 | `flash_read` | `(flash_base, buf, address, size) -> status` |
| 4 | 0x20 | `flash_get_info` | `(flash_base, info*) -> status`（info = {total_sz, sector_sz}，各 4 B） |
| 5 | 0x28 | `flash_erase_chip` | `(flash_base) -> status` |
| 6 | 0x30 | `flash_deinit` | `() -> void` |

- `header`：`xpi_nor_config_option_t` 的头字 = `words(4bit) | tag(0xfcf90) << 12`，
  即 1 个 option 字时 `0xFCF90001`、2 个时 `0xFCF90002`、不带 option 时 `0xFCF90000`。
- 每次调用以 `ebreak` 结束 → 调试器看到 halt，返回码在 `a0`。
- `status`：0 = 成功；其它值直接来自 ROM API（见 SDK `hpm_common.h` 的 `hpm_stat_t`）。

## 构建

```powershell
pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1
```

需要 HPM SDK 与本机 RISC-V 工具链，路径用环境变量覆盖（默认值见脚本头部）：
`$env:HPM_SDK_BASE` / `$env:RV_TOOLCHAIN`。脚本会：
1. 用 `-nostdlib` + `memset.c` 编译（**必须**：链 newlib 会把 1.4 KB 撑到 16.8 KB）；
2. 校验入口表（7 项、每项 +4 处是 `ebreak`、`jal` 目标落在 blob 内）；
3. 生成 `app/flash/hpm/algo.js`（blob 的 base64 + 描述符），网页直接用，不需要运行时构建。

实测尺寸：**1360 B text + 28 B data = 0x56C（1388 B）**，加载地址 `0x00000000`
（与 SDK 的 `-work-area-phys 0x00000000 -work-area-size 0x20000` 一致）。
