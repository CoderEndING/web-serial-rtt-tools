# 栈帧与局部变量：固件、Web 压测、GDB 对照

本次增加的是测试基础设施。akaLinkPro 探针固件和 RTT/JScope 的运行代码不变。
F103 与 H743 使用共享的 `tools/target-firmware/common/dbg_frames.c`，主循环新增第12阶段。
原有11个阶段保留，既有单步、断点、结构体与 DWT 验收仍可单独执行。

## 测试契约

固定输入，不比较 g_loops、SysTick 或中断计数。7个全局检查点符号指向准确的 NOP 指令：

| 检查点 | 核对内容 |
|---|---|
| recursive | 5层同名递归帧；depth_copy 为0..4，seed_copy 为1028、1021、1014、1007、1000 |
| leaf | 参数、leaf_value、局部数组 items、record 结构体中的有符号数和嵌套数组 |
| shadow | 外层 shadow=60、内层 shadow=70，两者按词法作用域分别读取 |
| shadow-exit | 内层变量消失，外层变量保持可见 |
| register | arg=23、register_value=70，检查寄存器位置 |
| before-call | arg=70、stack_value=79，参数位于寄存器 |
| after-call | arg=70 移至栈、result=346；位置迁移不能产生旧值 |

GDB 先独立读取板上的 Flash，与 ELF 的只读 Flash 段逐字节匹配，之后采集各检查点。
对照文件包含 ELF SHA-256、构建信息、GDB版本、共享测试代码 SHA-256、各帧函数/PC/SP、参数/局部变量、
可用状态、复合字段和内存位置。核心必测变量缺失、递归层数不够、固定输入答案错误，
或构建没有真正覆盖寄存器到栈的位置迁移，采集均失败。不会生成一个“部分覆盖”的合格答案。
变量从 GDB 各活动词法块按 Symbol 读取，不能用按名字求值把内外层同名变量都读成内层。

Web 侧重新验证板上 Flash；逐帧与 GDB 比较，正向/反向切帧，检查源码位置和选中按钮。
每次回溯/切帧前后比较 R0..R15、MSP/PSP/xPSR/CONTROL/PRIMASK/BASEPRI/FAULTMASK 和当前栈起点最多512字节，检查只读性。
默认200轮重复递归暂停，检查值、调用链、FPB槽位和故障计数。
写寄存器、写内存、单步、继续、重载 ELF、复位、断开后验证旧缓存失效。
仅两边都不可用的变量可以作为“不可用状态一致”，不能用它充当核心变量覆盖。
任何差异均报告失败。该专用验收关闭旧套件的 FAULT 重试包装，并拒绝意外复位/恢复记录。

## F103CB 基线流程（Windows，无需管理员）

以下命令从仓库根目录执行。需要 PATH 中的 PowerShell、ARM GCC、支持 Python 的 ARM GDB、
已有的 OpenOCD/GDB server，以及原有浏览器/CDP准备环境。
脚本不自动烧录，不替用户启动或终止其他工具，也不会杀掉未知进程。

1. 构建新测试固件：

```powershell
make build-dbg-frames-f103cb
```

输出：`tools/target-firmware/stm32f103_dbgstress/build-cb-og/fw.elf`、fw.bin、fw.hex、build-info.json。
默认 `-Og -g3 -gdwarf-4 -fasynchronous-unwind-tables`，所有输出独立于原 `-Os` 目录。
把这个目录里的新固件烧进板子；不要使用旧 `fw.elf` 快照或原来的 build-cb 产物。

2. 断开网页对探针的占用，启动适合板子的 GDB server，然后采集标准答案：

```powershell
make dbg-frame-oracle FRAME_REMOTE=127.0.0.1:3333
```

默认调用 arm-none-eabi-gdb。路径不同可传 `FRAME_GDB=...`。
F103ZE 的 BOOT0唤醒采用原有 VTOR/SP/PC配方；CB/H743采用正常复位。
采集失败会清除旧对照文件，3分钟超时会终止此次 GDB 客户端。
默认输出 `tmp/frame-oracle-f103cb.json`。

3. 退出 GDB server，释放探针，再运行 Web 验收：

```powershell
make test-dbg-frames
```

该入口要求有效对照文件，缺失或 ELF/构建参数不匹配时，在连接浏览器/探针之前失败。
默认200轮，可传 `FRAME_ROUNDS=500`。结果写入 `tmp/dbg-stress-page-f103cb.json`，
日志或报告中的任一失败项都会使退出码为1。常规综合 stress 仍使用原入口，另行运行。
两种客户端按顺序使用同一探针，不得同时连接。

## 优化与板型矩阵

```powershell
# F103CB DWARF5 + Og
pwsh -File tools/target-firmware/stm32f103_dbgstress/build.ps1 -Board cb -Optimization Og -Dwarf5
# F103CB DWARF4 + Os，保留旧默认构建目录
pwsh -File tools/target-firmware/stm32f103_dbgstress/build.ps1 -Board cb -Optimization Os
# H743 DWARF4 + Og
pwsh -File tools/target-firmware/stm32h743_dbgstress/build.ps1 -Optimization Og
```

每个构建都要重新烧录、重新采集 GDB 对照、重新运行 Web 压力验收。
通过 `FRAME_BOARD`、`FRAME_ELF`、`FRAME_ORACLE` 显式选择，不能混用：

| 板型/配置 | FRAME_ELF |
|---|---|
| F103CB Og/DWARF4 | /tools/target-firmware/stm32f103_dbgstress/build-cb-og/fw.elf |
| F103CB Og/DWARF5 | /tools/target-firmware/stm32f103_dbgstress/build-cb-dw5-og/fw.elf |
| F103CB Os/DWARF4 | /tools/target-firmware/stm32f103_dbgstress/build-cb/fw.elf |
| H743 Og/DWARF4 | /tools/target-firmware/stm32h743_dbgstress/build-og/fw.elf |
| H743 Og/DWARF5 | /tools/target-firmware/stm32h743_dbgstress/build-dw5-og/fw.elf |

高优化构建也采用严格对照。如果 GDB 能恢复而 Web 不支持，则验收失败并显示对应变量；
不自动豁免 entry_value、分片位置等当前尚未支持的表达式。先定位并修复，或明确调整发布范围。

## Cortex-M7 同步异常与断点误停

H743 的 Cortex-M7 可能触发 Arm erratum 3092511：异步异常与硬件断点同时发生时，调试器报告的
PC 会落在异常处理入口，而断点地址保存在异常栈帧中。此前 H743 Og/DWARF5 的递归压力因此偶发
显示 `SysTick_Handler`，不能据此当作栈帧值错误，也不能无条件重试。

压力脚本仅对 H743/Cortex-M7 做严格确认：当前 PC 必须在 `SysTick_Handler`；DFSR 必须有 BKPT 位，
DWT 不能报告观察点命中；用户断点及活动 FPB 比较器必须指向本轮检查点；当前异常号必须为 SysTick；
异常栈帧必须是线程态、Thumb 状态，且保存的 PC 与检查点完全一致。全部吻合后才恢复运行并等待
精确 FPB 停点，每个检查点最多恢复4次；任何证据缺失、地址不符或重复误停都仍然失败。
Arm 的 errata notice：[Cortex-M7 Software Developer Errata Notice，3092511](https://documentation-service.arm.com/static/665dff778ad83c4754308908)。

## 已执行验证

2026-10-06（Asia/Shanghai），H743 实板，SWD 10 MHz，FPB 8 个比较器/rev2：

| 配置 | 结果 | 说明 |
|---|---:|---|
| Os / DWARF4 | 19 通过 / 0 失败 | 7 个 GDB 检查点及 20 轮压力通过（02:57） |
| Os / DWARF5 | 19 通过 / 0 失败 | 7 个 GDB 检查点及 20 轮压力通过（02:59） |
| Og / DWARF5 | 19 通过 / 0 失败 | 03:25:15；7 个检查点与 GDB 逐项一致，200 轮递归/正反切帧通过；严格确认并恢复1次误停 |

Og/DWARF5 的早期 20 轮复测曾在一个检查点误停到 `SysTick_Handler`，PC 为 `0x080000f4`，
目标检查点为 `0x08000a3a`。加入上述证据核验后，H743 实板完整 200 轮通过，变量差异为0，
寄存器/栈未被回溯修改，FPB 无泄漏，写操作/单步/继续/重载 ELF/复位/断开后的旧缓存检查通过，
也没有意外复位或隐藏传输重试。此次执行使用 Og/DWARF5 ELF SHA-256
`c559f42988cfc43359ed07e897a895816dcf2b5b9c3d36b1647b0b9baee50153`，报告为
`tmp/dbg-stress-page.json`，GDB oracle 为 `tmp/frame-oracle-h743-og-dw5.json`。
递归压力中的 M7 误停恢复次数也保存在报告 `frameResults[0].pressureM7ErratumRecoveries` 字段；本次为1次，
保存的事件 PC 是 `SysTick_Handler`，DFSR.BKPT、目标 FPB 和异常栈保存的检查点地址均匹配。

## 离线检查及验证边界

- `make test-dbg-features`：真实既有 ARM ELF解析、变量/帧命令、对照契约和错误答案检测；浏览器/会话替身还检查压力流程、
  只读性、错误目标拒绝和失败收尾，不冒充硬件验证。
- `make test-dbg-frame-native`：需要本机 gcc，使用共享C代码，Og/Os 各运行10000轮；
  仅验证固定输入和编译警告，不代表 Cortex-M编译或板上性能。
- `make test-dbg-frame-gdb`：Python GDB API替身，覆盖复合字段、同名作用域、不可用值和帧边界；
  不是实际 ARM GDB对照。

本次本地也通过 `node tools/selftest/dbg-frame-contract.test.mjs` 和
`node tools/selftest/dbg-frame-hw-runner.test.mjs`；后者覆盖 M7 误停证据完整时恢复，
以及异常栈 PC 或 DFSR 证据不完整时拒绝恢复。板上验收仅覆盖本节所列 H743 构建，
F103CB 等其他板型仍需按上面的流程各自构建、采集 GDB oracle 和实测。

GDB API依据：
[Frames](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Frames-In-Python.html)、
[Blocks](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Blocks-In-Python.html)、
[Values](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Values-From-Inferior.html)。
