@echo off
rem ============================================================================
rem  双击即用：起本地网页服务（**不发缓存**的那个）并打开浏览器
rem
rem  为什么不能直接双击 index.html：file:// 下浏览器把 ES 模块当跨域请求挡掉，
rem  页面直接空；而且 WebUSB/Web Serial 必须跑在 http(s) 源上，file:// 连不了探针。
rem
rem  用法：
rem    双击              → 用 8899 端口起服务并打开 http://127.0.0.1:8899/index.html
rem    start-web.bat 9000 → 换端口（服务已经在跑就直接开页面）
rem
rem  这个窗口可以关：服务在**另一个最小化的窗口**里跑着，要停就关那个窗口，
rem  或者跑 `make serve-stop`（本仓 Makefile 的配方）。
rem ============================================================================
setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8899"
set "URL=http://127.0.0.1:%PORT%/index.html"

echo.
echo   串口 / RTT 工具箱 —— 本地网页
echo   ---------------------------------------------------------------
echo   仓库：%CD%
echo   地址：%URL%
echo.

rem ---- 1) 端口已经在监听？在跑就直接开页面 -------------------------------
netstat -ano | findstr ":%PORT% " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   [1/3] 服务已在运行（端口 %PORT%）—— 跳过启动
  goto :open
)

rem ---- 2) 起服务：优先 node 的"不发缓存"版，没有 node 就退到 python -------
where node >nul 2>nul
if not errorlevel 1 (
  echo   [1/3] 启动：node tools/dev/serve-nocache.mjs %PORT%   ^(后台最小化^)
  start "rtt-tools-web" /min cmd /c node "tools\dev\serve-nocache.mjs" %PORT%
  goto :wait
)
where python >nul 2>nul
if not errorlevel 1 (
  echo   [1/3] 没找到 node，改用：python -m http.server %PORT%
  echo         ^(提示：python 的 http.server 不发缓存头，改完代码记得 Ctrl+Shift+R^)
  start "rtt-tools-web" /min cmd /c python -m http.server %PORT% --bind 127.0.0.1
  goto :wait
)
echo   [x] 既没有 node 也没有 python —— 装一个再来（Node 18+： https://nodejs.org/）
echo       或者先用线上版： https://minichao9901.github.io/web-serial-rtt-tools/
echo.
pause
exit /b 1

rem ---- 3) 等服务就绪再开浏览器（最多等 20 秒）----------------------------
:wait
echo   [2/3] 等服务就绪…
for /l %%i in (1,1,20) do (
  ping -n 2 127.0.0.1 >nul
  netstat -ano | findstr ":%PORT% " | findstr /i "LISTENING" >nul 2>nul
  if not errorlevel 1 goto :open
)
echo   [!] 等了 20 秒端口还没起来 —— 还是先把浏览器打开，页面刷新一下看看

:open
echo   [3/3] 打开浏览器：%URL%
start "" "%URL%"
echo.
echo   ---------------------------------------------------------------
echo   完成。窗口可以关掉 —— 服务在另一个最小化的窗口里继续跑。
echo   · 停止服务：关掉那个最小化的窗口，或在本目录跑  make serve-stop
echo   · 换端口：  start-web.bat 9000
echo   · 探针要授权？ 跑一次  node tools/selftest/serial-grant.mjs
echo     （补你日常浏览器 profile 的串口/HID/WebUSB 授权；跑之前先退出那个浏览器）
echo.
rem 用 ping 当 sleep：timeout 在 stdin 被重定向时会直接报错（管道/日志里必踩），ping 两种情况都稳
ping -n 9 127.0.0.1 >nul
exit /b 0
