@echo off
rem 双击即启动本地桥（零 npm 依赖，只要有 Node 18+）
rem 参数会原样传给 rtt-bridge.mjs，例如： start-bridge.bat --target stm32f103
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] 找不到 node.exe —— 请先安装 Node.js 18 或更高版本： https://nodejs.org/
  pause
  exit /b 1
)
if "%~1"=="" (
  node "%~dp0rtt-bridge.mjs" --target stm32f103
) else (
  node "%~dp0rtt-bridge.mjs" %*
)
echo.
echo [桥已退出] 按任意键关闭窗口
pause >nul
