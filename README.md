# 串口 / RTT 工具箱（网页版）

零安装的调试小工具，纯静态页面，直接托管在 GitHub Pages：

**👉 [在浏览器里直接打开](https://minichao9901.github.io/web-serial-rtt-tools/)**
（桌面版 Chrome / Edge；无需安装任何东西，串口/探针在页面里授权一次即可）

| 标签页 | 干什么 | 需要什么 |
|---|---|---|
| **串口助手** | SSCOM 那套核心功能：端口/波特率、ASCII/HEX 收发、**ANSI 彩色接收**（像 MobaXterm）、时间戳、定时发送、5 条快捷发送、保存接收数据、**记录到文件**（高速采集不丢数）、**高速自动关显示**（>50KB/s 停渲染、数据照收） | 桌面版 Chrome / Edge（Web Serial） |
| **终端** | Xshell 式串口终端：xterm.js 渲染 ANSI、本地回显、回车/退格映射、粘贴发送 | 同上（与串口助手共用同一个串口会话） |
| **RTT Viewer** | SEGGER RTT 多通道查看 + 下行输入 + 复位目标，四种后端；同样支持记录到文件与高速自动关显示 | **零安装**：WebUSB + CMSIS-DAP 探针<br>**可选**：本地桥 + OpenOCD / J-Link |

> 为什么 RTT 要分三种后端：J-Link 与 OpenOCD 都是**本机程序**，网页无权启动进程、也无权开 TCP。
> 所以零安装模式下 RTT 走 **WebUSB 直连 CMSIS-DAP 探针**；想用 J-Link/OpenOCD 就启动仓库里的桥（`bridge/`）。

## 界面

| 串口助手 | 终端 |
|---|---|
| ![串口助手](docs/shots/1-serial.png) | ![终端](docs/shots/2-terminal.png) |

| RTT Viewer（内置模拟目标） |
|---|
| ![RTT](docs/shots/3-rtt-mock.png) |

（截图里第一个标签用的是**内置演示串口**，所以显示的是假设备；`?demo=serial` 就能自己试。）

## 实测状态（2026-09-26，真硬件：MicroLink CMSIS-DAP + STM32F103）

| 用例集 | 结果 |
|---|---|
| Node 协议层（控制块定位/环形绕回/丢包信号/下行写入/ELF 符号/HEX） | **34/34** |
| 桥端到端（真板，上行 ch0+ch1、下行命令、flood、复位） | **19/19** |
| 浏览器无硬件（演示串口的整条 UI 链路） | **15/15** |
| 浏览器 + 真探针（WebUSB 零安装 RTT：定位/上行/下行/复位） | **11/11** |
| 浏览器 + 桥（OpenOCD 后端：定位/上行/下行） | **5/5** |
| 串口助手真板（DAPLink CDC 桥到 PA9/PA10，`help/info/ansi/hex` 回包） | ✅ |

速度实测（同一探针同一条 SWD）：**WebUSB 单命令往返 0.34 ms、连续读 127 KB/s**；
**OpenOCD Tcl RPC 只有 ~17 KB/s** —— 大流量 RTT 优先用 WebUSB。详见 [`docs/backends.md`](docs/backends.md)。

## 快速开始

1. 打开页面（Pages 地址或本机的 `http://127.0.0.1:17321/`）。
2. **串口**：点「选择…」在浏览器弹框里选一次 COM 口（浏览器规定必须手动选一次），然后「连接」。
3. **RTT（零安装）**：RTT Viewer → 后端选 `WebUSB · CMSIS-DAP` → 「连接探针」→ 它会自动扫描 RAM 找到 `SEGGER RTT` 控制块（也可以先「载入 ELF…」用符号直接定位，更快）。
4. **RTT（J-Link / OpenOCD）**：双击 `bridge/start-bridge.bat`，页面里后端选「本地桥 · OpenOCD」→ 选目标芯片（常用 STM32 系列已内置；其它芯片选「自定义 cfg…」填 cfg 文件）→ 连接。

串口和 RTT 可以**同时**用（一个走 USB CDC、一个走探针）。

## 支持的调试后端

| 后端 | 通道 | 双向 | 目标控制 | 依赖 |
|---|---|---|---|---|
| **WebUSB · CMSIS-DAP v2** | 全部（页面读 ch0） | ✅ | 复位（nRESET 脉冲，复位后让它继续运行） | 只认 CMSIS-DAP 类探针（DAPLink / MicroLink / 自制 cherrydap…） |
| **本地桥 · OpenOCD** | 全部 | ✅ | halt/go/reset | 本机装 OpenOCD（ESP-IDF 自带那份即可） |
| **本地桥 · J-Link** | ch0（telnet 19021）或 `JLinkRTTLogger` 落文件 | ch0 ✅ | — | SEGGER J-Link 软件 |
| **内置模拟目标** | 1 up / 1 down | ✅ | 复位 | 无（演示与自测用） |

`WebUSB` 不支持 J-Link 探针（协议不开放）；反过来 J-Link 后端也不需要 WebUSB。

## 目录

```
index.html              单页三标签（无构建步骤）
app/
  core/                 bus/store/hex/format/rxview/stats/bin/b64 —— 与界面无关的纯逻辑
  serial/               session(Web Serial 封装) / assistant / terminal / demo(演示串口)
  rtt/                  protocol(RTT 协议) / dap-webusb(CMSIS-DAP) / bridge / elf / mock / view
  vendor/xterm/         xterm.js 本地副本（离线可用，MIT）
  ui/                   tabs / toast / dom 小工具
bridge/
  rtt-bridge.mjs        Node 单文件、零 npm 依赖：静态托管 + WebSocket + OpenOCD/J-Link 后端
  bridge.config.json    目标配置（stm32f103 / esp32s31 / …）
  start-bridge.bat|sh   双击启动
tools/
  selftest/             自测：Node 协议测试 / 桥端到端 / 浏览器真机(CDP) / LA 参考流量
  la/                   逻辑分析仪：kingst_la.py（KingstVIS Socket API 单文件工具）+ SWD 流量发生器
  target-firmware/      STM32F103 测试固件（UART + RTT，含 SEGGER RTT 源码）
docs/                   后端配置与排障；逻辑分析仪攻略.md（含 LA 工具完整源码与踩坑）
```

## 自测（不需要硬件也能跑一部分）

```powershell
# 1) 纯逻辑（RTT 协议 / ELF 符号 / HEX 解析）—— 不需要浏览器、不需要硬件
node tools\selftest\rtt.test.mjs

# 2) 页面端到端（内置演示串口，无需硬件）
python -m http.server 8899 --bind 127.0.0.1        # 仓库根
pwsh -File tools\selftest\launch-browser.ps1
node tools\selftest\browser-hw.test.mjs            # 只跑页面加载/缓存新鲜度检查
#   完整串口用例（无头跑不了设备授权，需要真窗口 + 已授权端口）：
#   http://127.0.0.1:8899/index.html?demo=serial&selftest=1

# 3) 桥 + 真硬件（需要 OpenOCD + 探针 + 目标板）
node bridge\rtt-bridge.mjs --target stm32f103
node tools\selftest\bridge.test.mjs

# 4) 浏览器 + 真硬件（CDP 驱动，需真窗口 + 已授权设备）
node tools\selftest\browser-hw.test.mjs webusb     # 零安装 RTT
node tools\selftest\browser-hw.test.mjs bridge     # 桥 + OpenOCD
node tools\selftest\browser-hw.test.mjs serial     # 串口助手
```

## 踩过的坑（都写在代码注释里）

- **CMSIS-DAP 响应回显**：响应首字节 = 命令回显。探针 IN 端点里可能残留**上一次会话**的响应包，
  天真地"发一条读一条"会整条错位；更阴的是 `DAP_Info` 的回显恰好是 `0x00`，错位后前两条 Info 会假装成功，
  一直到 `DAP_Connect` 才炸。→ 按命令回显匹配、丢弃陈旧包。
- **SWJ 激活序列**：`DAP_Connect` 只做引脚初始化，**主机必须自己发** 88 位序列
  （JTAG→SWD `9E E7` + 线复位 64 个 1 + 空闲 8 个 0）。少了它、或拆成几次发、或把末尾空闲写成 `0xFF`，
  都会让传输一路 `NO ACK(0x07)`（看着像"固件不应答"）。
- **`DAP_SWJ_Sequence` 的位计数是 1 字节**（0 表示 256），不是 2 字节。
- **`DAP_Transfer` 请求 = `[命令, DAP索引, 传输条数, (请求字节 + 4 字节数据)×N]`**，
  漏掉"索引+条数"两个字节 → 固件把请求字节当条数 → `count=0 / ACK=0`。
- **复位别用 `DAP_ResetTarget`**：它常把目标"复位并停住"，甚至留在半启动状态（`.bss` 都没清完）。
  拉 nRESET 脉冲最干净，复位后再确保目标在运行（写 DHCSR）。
- **`FAULT` 之后必须写 DP ABORT 清 sticky**，否则后面每次 AP 访问继续 FAULT（表现成"探针突然瞎了"）。
- **RTT 不重传**：目标写太快会覆盖/丢弃未读数据。最实用的过载信号是**缓冲水位**（≥3/4 记高位）+ 峰值，
  而不是死等"读满"。
- **页面在后台时浏览器会限速定时器**（RTT 轮询会掉到几 Hz），界面会如实提示。
- **ASCII 视图要按 UTF-8 解码**：逐字节当 Latin-1 会把设备发的中文全变成 `·`。
- **Windows 路径别喂给 Tcl**：OpenOCD 的 `program` 命令里 `\t`/`\b` 会被当转义吃掉（`couldn't open E:web...`）。
- **python -m http.server 不带 Cache-Control**：浏览器会启发式缓存 JS 模块，改完代码跑测试可能仍在跑旧模块。

## 许可

本仓库自有代码：Apache-2.0。第三方：`app/vendor/xterm/`（xterm.js，MIT）、
`tools/target-firmware/stm32f103/segger_rtt/`（SEGGER RTT，SEGGER 自己的许可，随上游分发）、
`tools/` 下的自测脚本（自有）。设备与调试器名称、商标归各自所有者。
