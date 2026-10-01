# ============================================================================
#  串口 / RTT 工具箱 —— 常用操作一键化
#
#  用法：make            看这份帮助
#        make open       起服务 + 打开自测浏览器（真机调试最常用）
#        make test       跑不需要硬件的自测
#        make test-hw    跑真机 WebUSB 验收（探针 + 目标板）
#        make fw-restore 把测试固件烧回板子（板子被烧花了就靠它）
#
#  设计约束（Windows 实测）：
#   · 本机 GNU Make 用的是 PATH 里的 sh.exe（E:\Share\env-windows\tools\bin\sh.exe），
#     别的机器上可能只有 cmd.exe —— 所以配方里**只用单条命令**，
#     平台相关动作一律交给 `pwsh -NoProfile -Command`（Windows 必装 PowerShell）。
#   · 路径统一用正斜杠（反斜杠会被 sh 当转义吃掉）。
#   · 中文输出走 tools/dev/help.ps1（把控制台编码切到 UTF-8，避免 GBK 下乱码）。
#   🚨 **配方（tab 后面那行）里一律不要写中文**（2026-10 实测，不只是乱码）：本机 make 走
#      sh.exe，非 ASCII 字符串经编码转换后**有的能跑（输出乱码）、有的直接让这条配方
#      Error 1 且不给任何提示** —— 可复现的最小例子是 `Write-Host '已在跑'`（换成
#      `'port 8899 is already up'` 立刻正常）。中文只放在 # 注释里，或放进 .ps1 脚本。
# ============================================================================

PY      ?= python
NODE    ?= node
PORT    ?= 8899
CDP     ?= 9333
TARGET  ?= stm32f103
APP     ?= http://127.0.0.1:$(PORT)/index.html
FW_DIR   = tools/target-firmware/stm32f103
LA       = tools/la/kingst_la.py

.DEFAULT_GOAL := help
.PHONY: help serve serve-dev serve-stop browser open page-prep test test-ui test-gen test-gen-page gen-embed samples-anim test-hid test-dwarf test-scope test-scope-page test-scope-render test-spi test-read test-spi-page test-hw test-record test-bridge test-bridge-gate test-hpm test-image test-all flash-timing hw-campaign hw-campaign-hpm campaign-summary \
        bridge bridge-stop fw-build fw-flash fw-restore fw-h7-build fw-h7-slow fw-h7-flash \
        algo-check flash-plan la-info la-capture git-status git-log check clean spi-hw spi-flow

help:
	pwsh -NoProfile -ExecutionPolicy Bypass -File tools/dev/help.ps1

# ---------------------------------------------------------------- 起页面
serve:
	$(PY) -m http.server $(PORT) --bind 127.0.0.1

# 开发用静态服务：**明确不发缓存**。—— 改页面时用这个
# 🚨 python -m http.server 不发 Cache-Control，浏览器就按"启发式缓存"自己决定存多久，
#    于是"改完代码 → 刷新 → 还是老的"，强刷都不一定管用（ES 模块的缓存尤其顽固）。
serve-dev:
	$(NODE) tools/dev/serve-nocache.mjs $(PORT)

serve-stop:
	pwsh -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force }"

browser:
	pwsh -NoProfile -File tools/selftest/launch-browser.ps1 -Port $(CDP) -Url $(APP)

# 起服务（后台，已在跑就跳过）再开浏览器 —— 一条命令进入真机调试状态
# 服务用**不发缓存**的那个（node tools/dev/serve-nocache.mjs）：改完代码普通刷新就能看到
open:
	$(NODE) tools/selftest/serial-grant.mjs --if-idle
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(NODE)' -ArgumentList 'tools/dev/serve-nocache.mjs','$(PORT)' -WorkingDirectory (Get-Location) -WindowStyle Hidden; Start-Sleep -Seconds 1 }; & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'"
	pwsh -NoProfile -Command "Write-Host '页面：$(APP)    浏览器调试端口：$(CDP)'"

# 探针授权（串口 + WebHID + WebUSB）——默认补「make open 起的那个 profile」和「自动化脚本用的那个」，
# 来源覆盖 线上 Pages / 127.0.0.1:8899 / localhost:8899。换 USB 口或换探针之后重跑一次即可。
#   make grant                 # 补（该 profile 的浏览器在跑会先关掉它）
#   make grant ARGS=--show     # 看：每个 profile / 来源下都有哪些授权、当前口在不在里面
#   make grant ARGS=--clean    # 清：删掉换口/换探针留下的过期条目
grant:
	$(NODE) tools/selftest/serial-grant.mjs $(ARGS)

# ---------------------------------------------------------------- 自测
test:
	$(NODE) tools/selftest/rtt.test.mjs
	$(NODE) tools/selftest/gen-parity.mjs
	$(NODE) tools/selftest/hid-proto.test.mjs
	$(NODE) tools/selftest/dwarf.test.mjs
	$(NODE) tools/selftest/scope-proto.test.mjs
	$(NODE) tools/selftest/bridge-origin.test.mjs
	$(NODE) tools/selftest/bridge-lifecycle.test.mjs
	$(NODE) tools/selftest/flash-image.test.mjs
	$(NODE) tools/selftest/hpm-flash.test.mjs
	$(NODE) tools/selftest/spi-proto.test.mjs
	$(NODE) tools/selftest/spi-panel-code.test.mjs
	$(NODE) tools/selftest/spi-read.test.mjs
	$(NODE) tools/selftest/spi-frames-dsl.test.mjs
	$(NODE) tools/selftest/spi-flash.test.mjs

# 固件文件解析（ELF 按节取 + VMA→LMA、HEX、.bin）—— 离线
test-image:
	$(NODE) tools/selftest/flash-image.test.mjs

# HPM（RISC-V）零安装烧录：跑在模拟 DTM + 模拟 XPI flash 上（不需要探针/板子）
test-hpm:
	$(NODE) tools/selftest/hpm-flash.test.mjs

# 重新构建 HPM flashloader（需要 HPM SDK + RISC-V 工具链），并刷新 app/flash/hpm/algo.js
hpm-algo:
	pwsh -NoProfile -File tools/target-firmware/hpm_flash_algo/build.ps1

# 桥的 WebSocket 准入（Origin 白名单 + 口令）：纯离线，自己拉一个桥实例只做握手
test-bridge-gate:
	$(NODE) tools/selftest/bridge-origin.test.mjs

# ELF/DWARF 变量提取（scope 页的变量浏览器底座）—— 基线是真 ELF 快照
test-dwarf:
	$(NODE) tools/selftest/dwarf.test.mjs

# J-Scope 引擎层：采样计划 / 512B 包编解码 / 缓冲+LOD / 触发 / 假探针端到端
test-scope:
	$(NODE) tools/selftest/scope-proto.test.mjs

# 「工程生成」页与 Python 工具（uvprojx2cmake.py）产物的逐字节对账
# 外加「本地桥安装包」生成器的自测（桥源码哈希对账 + bat/ps1/config 内容）
test-gen:
	$(NODE) tools/selftest/gen-parity.mjs
	$(NODE) tools/selftest/bridge-kit.test.mjs

# 改完 bridge/rtt-bridge.mjs 必须重嵌一次（否则「工程生成」页发出去的桥是旧的）
# 忘了也没事：test-gen 里那条哈希对账会红
gen-embed:
	$(NODE) tools/dev/embed-bridge.mjs

# 探针自定义 HID（RTT→CDC 转发）协议自测：组包 / 状态字 / 假探针流程
test-hid:
	$(NODE) tools/selftest/hid-proto.test.mjs

# 页面端到端（演示串口 + 假探针；驱动会自己拉 CDP 浏览器）
test-ui:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	$(NODE) tools/selftest/ui.page.test.mjs

# 「工程生成」页的真页面验收（需要 8899 服务 + 9333 CDP 浏览器，见 make open）
test-gen-page:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	pwsh -NoProfile -Command "try { $$null = Invoke-WebRequest 'http://127.0.0.1:$(CDP)/json/version' -TimeoutSec 2 -UseBasicParsing } catch { & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'; Start-Sleep -Seconds 2 }"
	$(NODE) tools/selftest/gen-page.test.mjs

# 「J-Scope 波形」页的真页面验收（假探针，不需要硬件；需要 8899 服务 + 9333 CDP 浏览器）
test-scope-page:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	pwsh -NoProfile -Command "try { $$null = Invoke-WebRequest 'http://127.0.0.1:$(CDP)/json/version' -TimeoutSec 2 -UseBasicParsing } catch { & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'; Start-Sleep -Seconds 3 }"
	$(NODE) tools/selftest/scope-page.test.mjs

# 波形渲染的几何自测：数 canvas 路径，钉住"放大到亚像素不能再断线"这个回归
test-scope-render:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	$(NODE) tools/selftest/scope-render.test.mjs

# 「SPI/QSPI 屏」页的引擎层：帧编解码 / 打包器（一帧不跨包）/ HID 0x35 偏移 / 假探针帧执行
test-spi:
	$(NODE) tools/selftest/spi-proto.test.mjs

# 屏的回读（读寄存器 / 读 GRAM → 预览 + BMP）：读计划、解码、BMP 头、假探针 GRAM 往返
test-read:
	$(NODE) tools/selftest/spi-read.test.mjs

# 手写多帧 DSL：解析 / 自动规则 / 错误必须带行号拦住（含面板示例的回归）
test-dsl:
	$(NODE) tools/selftest/spi-frames-dsl.test.mjs

# 外接 SPI NOR：JEDEC ID / SFDP / 状态寄存器解析 + 连续读拆帧 + 按页编程 + 器件模型
test-flash:
	$(NODE) tools/selftest/spi-flash.test.mjs

# 「SPI/QSPI 桥 + 屏」两页的真页面验收（假探针，不需要硬件；需要 8899 服务 + 9333 CDP 浏览器）
test-spi-page: page-prep
	$(NODE) tools/selftest/spi-bus-page.test.mjs && $(NODE) tools/selftest/spi-panel-page.test.mjs

# 「SPI/QSPI 屏」真机验收（探针 + 真屏）：默认 AXS15352/40MHz
#   make spi-hw                                  # 一屏一套：连接 → 推荐值 → 面板初始化 → 刷图
#   make spi-hw ARGS="--panel=st77916"           # 换 ST77916（档 2，QSPI）
#   make spi-hw ARGS="--sclk=20,40,60,75"        # 逐档 SCLK 刷一遍对比
#   make spi-hw ARGS=--loop                      # 先跑回环自检（要 J3[19]↔J3[21] 跳线）
spi-hw: page-prep
	$(NODE) tools/selftest/spi-hw.mjs $(ARGS)

# 「SPI/QSPI 屏」页面功能流程验收（用户 2026-09-29 指定顺序，出错即停）：
#   打开 web -> 连接探针 -> 初始化屏 -> 发图 x3 -> 再次初始化屏 -> 发图 x3
spi-flow: page-prep
	$(NODE) tools/selftest/spi-hw-flow.mjs $(ARGS)

# ---------------------------------------------------------------- 页面类脚本的共同前置
# 8899 静态服务 + 9333 CDP 浏览器（哪个不在就起哪个）。
# 🚨 2026-10 用户现场：直接 `make hw-campaign` 撞到
#    `TypeError: fetch failed … ECONNREFUSED 127.0.0.1:9333` —— 那是**CDP 浏览器没起**，
#    不是探针/板子的问题，但报错里只写着 "connect"，很容易往硬件上想。
#    现在这些"CDP 驱动真页面"的目标都依赖本前置，一条命令就能跑。
page-prep:
	$(NODE) tools/selftest/serial-grant.mjs --if-idle
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	pwsh -NoProfile -Command "try { $$null = Invoke-WebRequest 'http://127.0.0.1:$(CDP)/json/version' -TimeoutSec 2 -UseBasicParsing } catch { & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'; Start-Sleep -Seconds 3 }"

test-hw:
	$(NODE) tools/selftest/browser-hw.test.mjs webusb

# 烧录耗时体检（真机：探针 + 目标板 + 8899/CDP 浏览器）：把"慢在哪一步"量出来。
#   make flash-timing                        # 一轮时间线
#   make flash-timing ARGS=--minimize-after=1  # 第 2 轮前最小化窗口（真节流：页面不可见）
#   make flash-timing ARGS=--clamp             # 确定性模拟"每个短等待都被钳成 1 s"
flash-timing: page-prep
	$(NODE) tools/selftest/flash-timing.mjs $(ARGS)

# 「记录到文件」实测（OPFS 当 showSaveFilePicker 替身；createWritable/write/close 都是真的）
# 含"把 write 拖慢"的积压用例与逐字节校验 —— 钉住 .crswap 那套落盘语义
test-record: page-prep
	$(NODE) tools/selftest/recorder-file.test.mjs

# 真机场景基准（探针 + 目标板）:烧录 / RTT Viewer / RTT 转发 / J-Scope 全场景跑一遍并记时
#   make hw-campaign                        # 3 轮全场景 + 狂发↔scope 交替烧录 5 遍（约 4 分钟）
#   make hw-campaign ARGS="--cycles=1 --alt=1"   # 只冒烟一遍
hw-campaign: page-prep
	$(NODE) tools/selftest/hw-campaign.mjs $(ARGS)

# 真机场景基准 · HPM6800EVK（HPM6880 / RISC-V + JTAG，akaLinkPro 探针）
# 与上面那份同一套编排，差别：目标类型 RISC-V、RTT 控制块地址取自 ELF（AXI SRAM 0x01240000）、
# 不做 ARM-only 的 RTT Viewer 判决、速度线是 HPM 自己那套（见脚本里的 SPEC）。
#   make hw-campaign-hpm ARGS=--record          # 第一遍：只记录 + 打印"实测 × 80%"的 spec 建议
#   make hw-campaign-hpm                        # 之后：按 SPEC 判决（2 轮 + 交替 5 遍，约 7 分钟）
#   make hw-campaign-hpm ARGS="--cycles=1 --alt=1"   # 只冒烟一遍
hw-campaign-hpm: page-prep
	$(NODE) tools/selftest/hw-campaign-hpm.mjs $(ARGS)

# 把基准结果打成小结表（跑完会自动打；这里是对着历史 JSON 重打，不用碰硬件）
#   make campaign-summary                                   # 默认读 HPM 那份
#   make campaign-summary ARGS=tmp/campaign-result.json     # 读 F103 那份
campaign-summary:
	$(NODE) tools/selftest/campaign-summary.mjs $(ARGS)

test-bridge:
	$(NODE) tools/selftest/bridge.test.mjs

# 屏页「动画 / 视频」的示例素材（GIF / APNG / 动画 WebP / MP4 / WebM）—— 见 samples/anim/README.md
samples-anim:
	$(PY) tools/dev/make-anim-samples.py $(ARGS)

test-all: test test-ui test-hw test-bridge
	pwsh -NoProfile -Command "Write-Host '全部自测跑完'"

# ---------------------------------------------------------------- 本地桥
bridge:
	$(NODE) bridge/rtt-bridge.mjs --target $(TARGET)

bridge-stop:
	pwsh -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $$_.CommandLine -like '*rtt-bridge.mjs*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-Process openocd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

# ---------------------------------------------------------------- 目标固件
fw-build:
	pwsh -NoProfile -File $(FW_DIR)/build.ps1

fw-flash:
	pwsh -NoProfile -File $(FW_DIR)/flash.ps1

fw-restore: fw-build fw-flash
	pwsh -NoProfile -Command "Write-Host '测试固件已烧回，板子随时可用'"

# STM32H7B0（RTT 吞吐测试固件；板子换成 H7B0 时用这组）
H7_DIR = tools/target-firmware/stm32h7b0_rtt_speed

fw-h7-build:
	pwsh -NoProfile -File $(H7_DIR)/build.ps1

fw-h7-slow:
	pwsh -NoProfile -File $(H7_DIR)/build.ps1 -SlowClock

fw-h7-flash:
	pwsh -NoProfile -File $(H7_DIR)/flash.ps1

# 不依赖硬件的两项体检：flash 算法条目自洽性、烧录计划（擦除/分块/补齐/范围）
algo-check:
	$(PY) tools/dev/verify-algo.py

flash-plan:
	$(NODE) tools/dev/check-flash-plan.mjs $(FW_DIR)/build/fw.elf $(H7_DIR)/build/fw.elf

# ---------------------------------------------------------------- 逻辑分析仪
la-info:
	$(PY) $(LA) info

la-capture:
	$(PY) $(LA) capture --rate 100000000 --time 0.05 --out tmp/la-now.csv
	pwsh -NoProfile -Command "Write-Host '波形已存 tmp/la-now.csv；SWD 解码： $(PY) $(LA) decode tmp/la-now.csv --ch-clk 0 --ch-dio 1'"

# ---------------------------------------------------------------- git / 体检
git-status:
	git status --short
	git log --oneline -5

git-log:
	git log --oneline -15

check:
	$(NODE) --check app/rtt/dap-webusb.js
	$(NODE) --check app/core/pace.js
	$(NODE) --check app/rtt/view.js
	$(NODE) --check app/flash/view.js
	$(NODE) --check app/flash/runner.js
	$(NODE) --check app/gen/templates.js
	$(NODE) --check app/gen/fixes.js
	$(NODE) --check app/gen/model.js
	$(NODE) --check app/gen/view.js
	$(NODE) --check app/gen/zip.js
	$(NODE) --check app/hid/probe.js
	$(NODE) --check app/hid/mock.js
	$(NODE) --check app/hid/view.js
	$(NODE) --check app/elf/elf.js
	$(NODE) --check app/elf/dwarf.js
	$(NODE) --check app/scope/protocol.js
	$(NODE) --check app/scope/store.js
	$(NODE) --check app/scope/mock.js
	$(NODE) --check app/scope/render.js
	$(NODE) --check app/scope/transport.js
	$(NODE) --check app/scope/view.js
	$(NODE) --check app/spi/protocol.js
	$(NODE) --check app/spi/mock.js
	$(NODE) --check app/spi/transport.js
	$(NODE) --check app/spi/session.js
	$(NODE) --check app/spi/bus-view.js
	$(NODE) --check app/spi/panel-view.js
	$(NODE) --check app/spi/panel-code.js
	$(NODE) --check app/spi/panels-data.js
	$(NODE) --check app/spi/image.js
	$(NODE) --check app/spi/frames-dsl.js
	$(NODE) --check app/spi/flash.js
	$(NODE) --check app/main.js
	$(NODE) --check bridge/rtt-bridge.mjs
	pwsh -NoProfile -Command "Write-Host '语法检查通过'"

clean:
	pwsh -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue tmp/*.csv, tmp/*.bin, tools/la/__pycache__"
	pwsh -NoProfile -Command "Write-Host '清理完成（保留源码与构建产物）'"
