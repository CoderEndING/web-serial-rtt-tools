# 后端与实测数据

本文记录三种 RTT 后端**在本机真硬件上量出来的数字和坑**，选后端/排障时看这份。

测试平台：Windows + MicroLink CMSIS-DAP（VID:PID `0D28:0202`，接口0 = CMSIS-DAP v2，bulk EP1 IN / EP2 OUT，512 B/包）
目标：STM32F103（Cortex-M3 r1p1，SWD），跑 `tools/target-firmware/stm32f103` 那份测试固件。

## 一、速度对比（读目标内存，同一个探针同一条 SWD）

| 路径 | 单命令往返 | 连续读吞吐 | 备注 |
|---|---|---|---|
| **WebUSB · CMSIS-DAP** | **0.34 ms** | **127 KB/s**（2 KB 块 16.1 ms；512 B 块 4.6 ms） | Chrome/Edge 直接驱动探针 |
| **本地桥 · OpenOCD（Tcl RPC 6666）** | ~2 ms | **17 KB/s**（4 KB 读 237 ms；16 KB 读 1.3 s；64 KB 读 9.5 s） | 文本十六进制字返回，越大越不划算 |
| 本地桥 · OpenOCD（telnet + `dump_image`） | — | 与上面同量级 | 二进制落文件，省掉文本转换但没量到明显收益 |

**结论**：
- 大流量 RTT（>20 KB/s）用 **WebUSB**；OpenOCD 后端受限于 RPC 的文本通道，读数只有 ~17 KB/s。
- 这也解释了实测现象：目标一次往 4 KB 缓冲灌 8 KB 时，OpenOCD 后端只读到 ~4 KB（其余被固件按 SKIP 丢掉），
  而 WebUSB 后端在同一场景下缓冲水位只打到 ~30%。
- RPC 读**分块要小**：4 KB/次最快，16 KB 开始掉速、64 KB 只剩 6.7 KB/s（所以桥里固定 256 字 = 1 KB/次）。

## 二、OpenOCD 后端（桥）怎么驱动的

ESP-IDF 自带那份 OpenOCD（`~\.espressif\tools\openocd-esp32\v0.12.0-esp32-*`）够用，但要注意：

- **CMSIS-DAP v2 探针必须显式指定后端**：`-c "cmsis-dap backend usb_bulk"`，否则认不到（默认走 TCP 后端）。
- 桥走 **Tcl RPC（6666）** 而不是 telnet（4444）：`read_memory <addr> 32 <n>` 返回**文本十六进制字**
  （`0x47474553 0x52205245 …`），一条命令拿一整块，不用临时文件；
  telnet 那条路要用 `dump_image` 落文件再读回来，代码更绕。
- 目标控制：`halt` / `resume` / `reset run` 直接发。
- 探针的 `rtt server` 在 ESP-IDF 这份 fork 里是残缺的（只有 `rtt server`，没有 `rtt setup/start`），
  所以**RTT 协议是浏览器这边自己实现的**，OpenOCD 只当"读写内存 + 控制目标"的搬运工。

目标配置写在 `bridge/bridge.config.json`：`cfgs` 顺序加载，`pre` 里的命令插在第一个 cfg 之后、
其余 cfg 之前（`cmsis-dap backend usb_bulk` 必须赶在 `target/*.cfg` 里的 `transport select` 之前）。

## 三、J-Link 后端（未实测）

本机没有 J-Link 探针，所以这条路**没有在真硬件上验证过**，只按 SEGGER 文档实现：

- **attach 模式**：连本机 `127.0.0.1:19021`（J-Link 的 RTT telnet 服务），ch0 全双工。
  前提是已经有一个带 RTT 的 J-Link 会话在跑（例如 JLinkRTTViewer）。
- **logger 模式**：桥自己拉 `JLinkRTTLogger.exe -Device X -If SWD -Speed N -RTTChannel n <文件>`，
  tail 文件内容 → 只读，但能拿任意通道。可用参数（本机 V8.82 实测的 `-?` 输出）：
  `-Device -If -Speed -USB -IP -RTTAddress -RTTSearchRanges -RTTChannel -JLinkScriptFile <OutFilename>`。
- J-Link **没有 WebUSB 通路**（协议不开放；`JLinkUSBWebServer.exe` 只是开 SEGGER 自家的网页界面，
  不对外提供 RTT API），所以想用 J-Link 就必须起桥。

## 四、WebUSB 后端的坑（都是真机踩出来的）

按重要性排序，全部写在 `app/rtt/dap-webusb.js` 的注释里：

1. **SWD 激活序列必须主机自己发**：`DAP_Connect` 只做引脚初始化。少发 88 位激活序列
   （`9E E7` + 64 个 1 + 8 个 0）时，SWJ-DP 还停在 JTAG 模式，之后所有传输一律 `NO ACK(0x07)`。
   **必须一次发完 88 位**：拆成 16/64/8 三次、或把末尾空闲写成 `0xFF`，都会让这个探针的 SWJ 引擎
   进入"传输全 NO ACK"的状态（本机实测，最后是靠工作区里验证过的裸客户端 `tools\la\cmsis_dap_raw.py` 定的写法）。
   顺序也要照它：`Connect → SWJ_Clock → SWD_Configure → SWJ_Sequence(88) → TransferConfigure`。
2. **线复位之后的第一个 SWD 包必须是「读 DP IDCODE」**（ARM SWD 协议的激活步骤）。
   少了这一笔，后面任何访问（哪怕是写 DP SELECT）都返回 `NO ACK(0x07)` —— 而包头完全正确、
   探针也照常回响应，极具误导性。定位手段：`tools\selftest\debug-sweep.mjs`（在页面上做参数扫描）。
3. **激活序列之后不要再设时钟**：实测那样也会把链路弄成一路 NO ACK。
4. **清掉上一场会话残留在 IN 端点里的响应**（`resync()`）：响应的回显不唯一，
   残留的 `DAP_Transfer` 响应回显同样是 `0x05`，光靠"按回显匹配"分不出来，
   会被当成自己这条命令的响应 → 初始化看着正常、下行命令却乱套。
   做法是连发 N 条 `DAP_Disconnect`（回显 `0x03` 很罕见）再把 N 条响应全读掉；
   ⚠️ **不要用"短超时读一下"去 flush** —— WebUSB 没有取消接口，被弃置的 `transferIn` 会偷走下一条响应。
   （同一个探针用 libusb/pyusb 一直是好的：libusb 认领接口时会自己 clear_halt 冲掉这些数据。）
5. **DAP_SWJ_Sequence 的位计数是 1 字节**（0 = 256），不是 2 字节；写错会让数据整体错位一格。
6. **DAP_Transfer 请求布局**：`[命令, DAP索引, 传输条数, (请求字节 + 4 字节数据)×N]`。
   漏掉"索引+条数"两个字节 → 固件把请求字节当条数 → 响应 `count=0 / ACK=0`。
7. **一整包发送**：命令补齐到整包（512 B）再发，和验证过的裸客户端一致。
8. **复位别用 `DAP_ResetTarget`**：它会把目标"复位并停住"，甚至留在半启动状态。
   用 **nRESET 脉冲**；而**拉过 nRESET 之后 SWD 可能整条哑掉**（再怎么发激活序列都 NO ACK），
   这时唯一的干净恢复是**重开 USB 会话**（释放接口再认领 + 重新初始化）——已经实现在 `reset()` 里，
   不用再让用户拔插。`SWJ_Pins` 的 `wait` 参数单位是**微秒**。
9. **FAULT 之后必须写 DP ABORT 清 sticky**，否则后续 AP 访问全部继续 FAULT（像是"探针瞎了"）。
10. **控制块要校验结构再认**：RAM 里可能出现**上一次固件编译留下的旧控制块**（"SEGGER RTT" 字符串还在），
    锁错了就会读出垃圾通道项。`Rtt.validate()` 会检查通道数、缓冲大小、读写指针、缓冲指针对齐。
11. **页面在后台时定时器被限速**（实测轮询从 ~190 Hz 掉到 ~4 Hz）。跑自动化测试要加
    `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`。

## 五、走桥时的节奏（OpenOCD Tcl RPC）

一轮 `readUp` 是 3 条 RPC（读通道项 + 读数据 + 回写 RdOff）。按 WebUSB 那种 190 Hz 猛刷就是
~570 条/秒，OpenOCD 的 Tcl 口扛不住，会冒出 `read_memory 只回来 0 个字` 的瞬时失败。
所以桥后端的轮询有 **30 ms 间隔下限**，并且 `readMem` 遇到短读会重试一次。
OpenOCD 的读数本来也只有 ~17 KB/s，快轮询没有意义。

## 五、目标固件（`tools/target-firmware/stm32f103`）

一份给本工具当靶子的最小固件：UART（USART1，PA9/PA10，115200）+ SEGGER RTT
（ch0 `Terminal` 带 ANSI 颜色、ch1 `Log`），命令既能从串口敲也能从 RTT 下行敲，输出同时进两路。

- 命令：`help / info / uptime / echo <文本> / led on|off|toggle / hex / ansi / long / flood [KB] / reboot`
- 编译：`pwsh -File build.ps1`（用 `arm-none-eabi-gcc`，不需要 Keil；本机在
  `E:\Share\env-windows\tools\gnu_gcc\arm_gcc\mingw\bin`）
- 烧录：`pwsh -File flash.ps1`（OpenOCD + CMSIS-DAP；路径会自动转成**正斜杠**，
  否则 Tcl 把 `\t`/`\b` 当转义吃掉）
- 串口自测：`python test_uart.py`（DAPLink 的两个 CDC 都试；本机 **COM66** 才是桥到 PA9/PA10 的那路，
  COM61 是探针自己跑的 PikaPython REPL）
- ⚠️ 固件的 UART 输出必须**有忙等上限，而且上限要小**：DAPLink 的 CDC 串口没主机读的时候会堵，
  死等 `TXE` 会把主循环一起卡死（现象："RTT 日志还在刷，但发命令没反应"）。
- 🚨 **`out()` 必须"先写 RTT、再写串口"**：反过来时串口那一侧的堵塞会把 RTT 输出一起饿死 ——
  实测现象极具迷惑性：**ch1（只走 RTT）正常刷，ch0（先写串口再写 RTT）一个字节都没有**。
  这是本项目里最后一个把"下行命令没反应"伪装成"RTT 坏了"的 bug。

## 六、自测现状（2026-09-26 全部真机通过）

| 用例集 | 结果 | 命令 |
|---|---|---|
| Node 协议层（控制块定位/绕回/丢包/下行/ELF/HEX） | **34/34** | `node tools\selftest\rtt.test.mjs` |
| 桥端到端（真板，上下行 + 复位 + flood） | **19/19** | `node bridge\rtt-bridge.mjs --target stm32f103` → `node tools\selftest\bridge.test.mjs` |
| 浏览器无硬件（演示串口，整条 UI 链路） | **15/15** | `index.html?demo=serial&selftest=1` |
| 浏览器 + 真探针（WebUSB 零安装 RTT） | **11/11** | `node tools\selftest\browser-hw.test.mjs webusb` |
| 浏览器 + 桥（OpenOCD 后端） | **5/5** | `node tools\selftest\browser-hw.test.mjs bridge` |
