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
.PHONY: help serve serve-stop browser open test test-ui test-hw test-bridge test-all \
        bridge bridge-stop fw-build fw-flash fw-restore fw-h7-build fw-h7-slow fw-h7-flash \
        algo-check flash-plan la-info la-capture git-status git-log check clean

help:
	pwsh -NoProfile -ExecutionPolicy Bypass -File tools/dev/help.ps1

# ---------------------------------------------------------------- 起页面
serve:
	$(PY) -m http.server $(PORT) --bind 127.0.0.1

serve-stop:
	pwsh -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force }"

browser:
	pwsh -NoProfile -File tools/selftest/launch-browser.ps1 -Port $(CDP) -Url $(APP)

# 起服务（后台，已在跑就跳过）再开浏览器 —— 一条命令进入真机调试状态
open:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }; & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'"
	pwsh -NoProfile -Command "Write-Host '页面：$(APP)    浏览器调试端口：$(CDP)'"

# ---------------------------------------------------------------- 自测
test:
	$(NODE) tools/selftest/rtt.test.mjs

test-ui:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	$(NODE) tools/selftest/ui.selftest.mjs

test-hw:
	$(NODE) tools/selftest/browser-hw.test.mjs webusb

test-bridge:
	$(NODE) tools/selftest/bridge.test.mjs

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
	$(NODE) --check app/rtt/view.js
	$(NODE) --check app/flash/view.js
	$(NODE) --check app/flash/runner.js
	$(NODE) --check app/main.js
	$(NODE) --check bridge/rtt-bridge.mjs
	pwsh -NoProfile -Command "Write-Host '语法检查通过'"

clean:
	pwsh -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue tmp/*.csv, tmp/*.bin, tools/la/__pycache__"
	pwsh -NoProfile -Command "Write-Host '清理完成（保留源码与构建产物）'"
