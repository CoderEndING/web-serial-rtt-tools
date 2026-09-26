<#
  用 OpenOCD + CMSIS-DAP 把测试固件烧进 STM32F103
    pwsh -File flash.ps1            # 烧录 + 校验 + 复位运行
    pwsh -File flash.ps1 -Erase     # 先整片擦除
  注意：ESP-IDF 自带的那份 OpenOCD 才认 CMSIS-DAP v2（D:\sdk_env 里的 0.11 不认），
        并且要显式 "cmsis-dap backend usb_bulk"。
#>
param([switch]$Erase, [string]$OpenOcd, [string]$Scripts)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$elf = Join-Path $root 'build\fw.elf'
if (-not (Test-Path $elf)){ throw "先跑 build.ps1（找不到 $elf）" }

if (-not $OpenOcd){
  $hit = Get-ChildItem "$env:USERPROFILE\.espressif\tools\openocd-esp32\*\openocd-esp32\bin\openocd.exe" -ErrorAction SilentlyContinue |
         Sort-Object FullName | Select-Object -Last 1
  if (-not $hit){ throw '找不到 openocd.exe（用 -OpenOcd 指定）' }
  $OpenOcd = $hit.FullName
}
if (-not $Scripts){ $Scripts = Join-Path (Split-Path -Parent (Split-Path -Parent $OpenOcd)) 'share\openocd\scripts' }

$cmds = @('init')
if ($Erase){ $cmds += 'reset halt' ; $cmds += 'stm32f1x mass_erase 0' }
# 🚨 路径必须转成正斜杠：OpenOCD 的命令走 Tcl 解析，Windows 反斜杠会被当转义吃掉
#    （症状：couldn't open E:web-serial-rtt-tools<TAB>ools... —— \t 变 Tab、\b 变退格）
$elfTcl = $elf -replace '\\', '/'
$cmds += "program `"$elfTcl`" verify reset exit"

Write-Output "openocd : $OpenOcd"
Write-Output "scripts : $Scripts"
Write-Output ("命令    : " + ($cmds -join '; '))
& $OpenOcd -s $Scripts -f "$Scripts\interface\cmsis-dap.cfg" -c "cmsis-dap backend usb_bulk" `
  -f "$Scripts\target\stm32f1x.cfg" -c ($cmds -join '; ') 2>&1 |
  ForEach-Object { $_ }
if ($LASTEXITCODE -ne 0){ throw "烧录失败 (exit $LASTEXITCODE)" }
Write-Output "烧录完成"
