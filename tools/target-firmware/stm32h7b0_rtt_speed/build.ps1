<#
  STM32H7B0 RTT 吞吐测试固件编译脚本（不需要 make，也不需要 Keil）
    pwsh -File build.ps1                # 默认：HSI→PLL1 跑 280MHz（VOS0）
    pwsh -File build.ps1 -SlowClock     # 保命档：只跑 HSI 64MHz，完全不碰 PLL/VOS
    pwsh -File build.ps1 -Clean

  依赖：arm-none-eabi-gcc 在 PATH 里（本机在 E:\Share\env-windows\tools\gnu_gcc\arm_gcc\mingw\bin）

  为什么留 -SlowClock：H7 的 280MHz 要 VOS0 + PLL + Flash latency 一起对才行，
  自定义板上第一次 bring-up 时"起不来"的原因常常分不清是时钟还是别的 ——
  先用 64MHz 编一版能跑通，就能把范围缩到时钟配置那几行。
#>
param([switch]$Clean, [switch]$SlowClock)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$build = Join-Path $root 'build'

$gcc = (Get-Command arm-none-eabi-gcc -ErrorAction SilentlyContinue).Source
if (-not $gcc){
  $guess = 'E:\Share\env-windows\tools\gnu_gcc\arm_gcc\mingw\bin\arm-none-eabi-gcc.exe'
  if (Test-Path $guess){ $gcc = $guess } else { throw 'arm-none-eabi-gcc 不在 PATH 里' }
}
$bin = Split-Path -Parent $gcc
$objcopy = Join-Path $bin 'arm-none-eabi-objcopy.exe'
$size    = Join-Path $bin 'arm-none-eabi-size.exe'

if ($Clean -and (Test-Path $build)) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $build | Out-Null

$sources = @(
  (Join-Path $root 'src\main.c'),
  (Join-Path $root 'src\startup.c'),
  (Join-Path $root 'segger_rtt\SEGGER_RTT.c')
)
$elf = Join-Path $build 'fw.elf'

# 参数一律加引号并用数组 splat：
# PowerShell 会把 -specs=nano.specs 按点号拆成两段（"-specs=nano" + ".specs"），
# 直接导致 "cannot read spec file 'nano'"（F103 那份脚本踩过，这里照抄修法）。
$cflags = @(
  '-mcpu=cortex-m7', '-mthumb', '-Os', '-g3',
  '-mfpu=fpv5-d16', '-mfloat-abi=hard',          # H7 的 FPU 是双精度；启动代码会打开它
  '-ffunction-sections', '-fdata-sections', '-fno-common',
  '-Wall', '-Wextra', '-Wno-unused-parameter',
  "-I$root\src", "-I$root\segger_rtt",
  "-T$root\ld\stm32h7b0.ld",
  '-nostartfiles', '-specs=nano.specs', '-specs=nosys.specs',
  '-Wl,--gc-sections', "-Wl,-Map=$build\fw.map"
)
if ($SlowClock){ $cflags += '-DHSI_64MHZ_ONLY=1' }

& $gcc @cflags @sources -o $elf
if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }

& $objcopy -O binary $elf (Join-Path $build 'fw.bin')
& $objcopy -O ihex   $elf (Join-Path $build 'fw.hex')
& $size $elf

Write-Output ""
Write-Output ("时钟    ： {0}" -f $(if ($SlowClock) { 'HSI 64MHz（保命档）' } else { 'HSI→PLL1 280MHz（VOS0）' }))
Write-Output ("产物    ： {0}" -f $elf)
Write-Output ("          {0} ({1} B)" -f (Join-Path $build 'fw.bin'), (Get-Item (Join-Path $build 'fw.bin')).Length)
Write-Output ""
Write-Output "下一步："
Write-Output "  烧录（OpenOCD 兜底）： pwsh -File flash.ps1"
Write-Output "  零安装烧录：在网页「烧录器」里选 stm32h7b0 → 选 build\fw.elf → 烧录"
Write-Output "  测速：网页 RTT Viewer 连上后看「读取 KB/s」；或 node tools\selftest\rtt-speed.mjs"
