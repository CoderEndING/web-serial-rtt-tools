# 显示 Makefile 的帮助。单独放成脚本是为了把控制台编码切到 UTF-8 ——
# 本机控制台默认 GBK，直接 echo 中文会乱码。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$lines = @(
  '串口 / RTT 工具箱 —— 一键操作'
  ''
  '  make open          起静态服务 + 打开自测浏览器（一键盘真机调试）'
  '  make serve         只起静态服务（前台，端口 8899；Ctrl+C 停）'
  '  make serve-stop    停掉占用 8899 的进程'
  '  make browser       只打开带 CDP 的自测浏览器（端口 9333）'
  ''
  '  make test          纯逻辑自测（RTT 协议 / ELF / HEX / 工程生成对账 / 探针 HID 协议，不需要硬件）'
  '  make test-gen      只跑「工程生成」页与 Python 工具产物的逐字节对账'
  '  make test-hid      只跑探针自定义 HID（RTT→CDC 转发）协议自测'
  '  make test-ui       页面端到端（演示串口 + 假探针，不需要硬件）'
  '  make test-gen-page 「工程生成」页真页面验收（需要 make open 起的浏览器）'
  '  make test-record    记录到文件的落盘语义（.crswap / 积压 / 落盘进度；OPFS 替身，不需硬件）'
  '  make test-hw       真机 WebUSB RTT 验收（探针 + 目标板）'
  '  make flash-timing  烧录耗时体检（真机：慢在哪一步、是不是探针的锅；ARGS=--clamp 模拟后台节流）'
  '  make hw-campaign   真机场景基准 · STM32F103ZE（烧录 / RTT Viewer / RTT 转发 / J-Scope，全跑一遍并判决）'
  '  make hw-campaign-hpm  真机场景基准 · HPM6800EVK（RISC-V/JTAG，含 RTT Viewer 的 RISC-V 通路）'
  '                     ARGS=--record 只记录并给出 spec 建议；ARGS="--cycles=1 --alt=1" 冒烟'
  '  make test-bridge   桥端到端（OpenOCD + 探针 + 目标板）'
  '  make test-all      上面全跑一遍'
  ''
  '  make bridge        起本地桥（OpenOCD 后端，默认目标 stm32f103）'
  '  make bridge-stop   停掉本地桥与 OpenOCD'
  ''
  '  make fw-build      编译 STM32F103 测试固件'
  '  make fw-flash      用 OpenOCD 烧测试固件'
  '  make fw-restore    = fw-build + fw-flash（板子被烧花了就用它救）'
  ''
  '  make fw-h7-build   编译 STM32H7B0 RTT 吞吐测试固件（HSI→PLL1 280MHz）'
  '  make fw-h7-slow    同上但只跑 HSI 64MHz（bring-up 保命档）'
  '  make fw-h7-flash   用 OpenOCD 烧 H7B0（首选还是网页里的零安装 WebUSB 烧录）'
  ''
  '  make algo-check    校验 algos.js 里各芯片 flash 算法条目是否自洽（不碰硬件）'
  '  make flash-plan    用纯计算演练一遍烧录计划（擦除/分块/补齐/范围，不碰硬件）'
  ''
  '  make la-info       逻辑分析仪状态（需要 KingstVIS 正在运行）'
  '  make la-capture    抓一段 SWD 波形到 tmp/la-now.csv'
  ''
  '  make git-status    git 状态 + 最近 5 条提交'
  '  make git-log       最近 15 条提交'
  '  make check         语法体检（node --check 各模块）'
  '  make clean         清掉临时采集/构建杂物'
)
$lines | ForEach-Object { Write-Host $_ }

