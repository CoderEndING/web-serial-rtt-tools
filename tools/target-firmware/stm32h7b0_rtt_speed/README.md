# STM32H7B0 · SEGGER RTT 吞吐（饱和速度）测试固件

拿这块板子量 **RTT 端到端能跑多快**：目标死循环灌数据，主机（网页 WebUSB / 桥+OpenOCD）拼命取，
页面上「读取 xxx KB/s」就是这块板子 + 这条主机通路的**饱和吞吐**。
套路与 [`../stm32f103_rtt_speed`](../stm32f103_rtt_speed) 完全一致，方便两块板子横向对比。

## 它到底在测什么

```
while(1) SEGGER_RTT_Write(0, "hello world!\n", 13);   // 不延时、不碰串口
```
RTT 用 **BLOCK_IF_FIFO_FULL**（`segger_rtt/SEGGER_RTT_Conf.h`）：缓冲满就阻塞 ⇒
**目标写多快完全由主机取多快决定**，主机读到的 B/s 就是这条通路的实际吞吐。
（所以"目标主频高"只保证它总能填满缓冲；瓶颈在主机侧 —— 这正是要测的。）

三个全局量留给主机读，交叉验证用：

| 符号 | 含义 |
|---|---|
| `g_bytes` | 目标实际写出的字节数（阻塞模式下 ≈ 主机读到的字节数） |
| `g_loops` | 循环次数（×13 = g_bytes） |
| `g_ms` | SysTick 毫秒数 —— **判目标死活**：阻塞在 RTT 写里它照样在走，不涨才是真卡死 |
| `g_sysclk_hz` | 实际切过去的系统时钟（确认 280MHz 有没有生效） |

## 快速开始

```powershell
# 1) 编译（两条命令，不需要 Keil/Make）
pwsh -File build.ps1              # 默认 HSI→PLL1 280MHz（VOS0）
pwsh -File build.ps1 -SlowClock   # 保命档：只用 HSI 64MHz，完全不碰 PLL/VOS

# 2) 烧录（首选：网页「烧录器」→ 后端 WebUSB → 芯片 stm32h7b0 → 选 build\fw.elf）
pwsh -File flash.ps1              # 兜底通道：OpenOCD（target/stm32h7x.cfg）

# 3) 测速：网页 RTT Viewer → 后端 WebUSB → 连接探针
#          芯片选「STM32H7B0/H7A3/H7B3」→ 它会扫 DTCM + AXI SRAM 找到控制块
#          看左下角「读取 xxx KB/s」；SWD 时钟先用「自动」，再手工比 8/12/20MHz
```

命令行测速（不起浏览器）：

```powershell
node tools\selftest\rtt-speed.mjs                       # 用 pyOCD? 不需要——走网页同款 WebUSB 通路时用下面的
CLOCKS=4000,8000,12000,20000 SECS=4 node tools\selftest\rtt-speed-webusb-sweep.mjs
```
（`rtt-speed-webusb-sweep.mjs` 需要先开着带调试端口的浏览器：`make browser`）

## 这块板子上要注意的（都是 H7 特有的坑）

1. **内存是散的**：DTCM 0x20000000(128KB，内核直连、免时钟) / AXI SRAM 0x24000000(1MB，要开 D1 时钟) /
   AHB SRAM 0x30000000…。本工程把代码放 flash、**数据/栈/RTT 缓冲全放 DTCM**，
   所以链接脚本只有两段内存（`ld/stm32h7b0.ld`），也**不用开任何外设时钟**。
2. **280MHz 要 VOS0**：先 `SYSCFG_PWRCR.ODEN=1`，再把 `PWR_D3CR.VOS` 设成 `0b11`，
   否则 PLL 配得再对内核也上不去（现象：一跑就 HardFault 或根本没切过去）。
3. **Flash 等待周期**：升频**之前**就要把 `FLASH_ACR.LATENCY` 提上去。本工程取 4（宁可多等，
   给少了会读到错指令），`WRHIGHFREQ` 按 185~285MHz 档。手上是 H7B3/H7A3 跑更高频时照 RM0455 复核。
4. **HSI 就是 64MHz**：H7 不需要外部晶振也能到 280MHz —— 自定义板子常常没焊 HSE，这点很省事。
   板上有晶振、想要更准的时钟：把 `clock_280mhz_hsi()` 换成 HSE 版本（改 `RCC_PLLCKSELR.PLLSRC` 与 DIVM1）。
5. **烧录粒度 32 字节**：H7 的 flash 按 256 位（32B）flash word 编程 ——
   `app/flash/algos.js` 里 H7B0 条目带 `write_granularity: 32`，烧录器会照它补 0xFF。
6. **H7B0 的 flash 只有 128KB**（value line）。如果你手上是 H7B3/H7A3（2MB/1MB），
   把 `ld/stm32h7b0.ld` 的 `FLASH LENGTH` 和 `app/flash/algos.js` 里的 `flash_length` 一起放大。
7. **F7/M7 的 FPU**：编译开了 `-mfpu=fpv5-d16 -mfloat-abi=hard`，所以 `startup.c` 里必须打开
   CPACR 的 CP10/CP11（否则一用浮点指令就跑飞）。本工程其实不用浮点，留着是为了别踩这个坑。
8. **SWD 引脚**：默认 PA13(SWDIO)/PA14(SWCLK)，别在固件里复用它们；nRST 建议接到探针（不接也能烧，
   但"复位运行"要用 AIRCR 软复位，工具里已经这么做）。

## 预期数字（供对照）

| 板子 | SWD 时钟 | 饱和吞吐（网页 WebUSB，实测） |
|---|---|---|
| STM32F103C8（72MHz） | 8MHz | ~250–260 KB/s |
| STM32H7B0（280MHz） | 待你实测 | ? |
| 任一板 + 桥/OpenOCD | 4MHz | ~17 KB/s（Tcl RPC 是瓶颈） |

> 吞吐主要取决于**主机侧每轮往返次数**与 SWD 时钟，跟目标主频关系不大（目标只要灌得满缓冲）。
> 所以 H7B0 的数字应该和 F103 接近 —— 如果明显更高/更低，值得看看是不是掉进了"错位读自愈"或缓冲高位。

## 目录

```
src/main.c              死循环发 RTT + 时钟初始化（HSI→PLL1 280MHz / -SlowClock 64MHz）
src/startup.c           向量表 + .data/.bss + FPU 使能（M7）
src/stm32h7b0_regs.h    只列本工程碰的寄存器（RCC/PWR/SYSCFG/FLASH/DBGMCU/SysTick）
ld/stm32h7b0.ld         FLASH 128KB + DTCM 128KB
segger_rtt/             SEGGER RTT 源码（与 F103 那份同版本，Conf 里 BUFFER_SIZE_UP=4096）
build.ps1 / flash.ps1   编译 / 烧录
```

## 许可

自有代码 Apache-2.0；`segger_rtt/` 是 SEGGER 的实现，随上游分发（见其目录内 README-SEGGER.md）。
