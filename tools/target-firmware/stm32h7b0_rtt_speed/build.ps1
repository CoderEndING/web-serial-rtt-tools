<#
  STM32H7B0 RTT 吞吐测试固件编译脚本（不需要 make，也不需要 Keil）

    pwsh -File build.ps1                # 默认：**HAL/SDK 版**（板子 demo 的时钟配置，280MHz）
    pwsh -File build.ps1 -Minimal       # 寄存器版（不依赖任何 SDK，最小体积，自带三级降级）
    pwsh -File build.ps1 -SlowClock     # 保命档：寄存器版 + 只跑 HSI 64MHz（完全不碰 PLL/VOS）
    pwsh -File build.ps1 -Clean

  依赖：arm-none-eabi-gcc 在 PATH 里（本机在 E:\Share\env-windows\tools\gnu_gcc\arm_gcc\mingw\bin）

  两个版本为什么都留着：
    · HAL/SDK 版 —— 时钟配置**原样用板子 demo 的 SystemClock_Config()**（ST 验证过），
      是最省心的正路。代价是要带一堆 HAL 源码（sdk\ 目录）。
    · 寄存器版（-Minimal）—— 一个外部文件都不依赖，只有 ~1.6KB；
      做 bring-up 对照实验、或者 SDK 目录不在身边时用它。
    · -SlowClock 更是保命：64MHz 完全绕开 VOS0/PLL，"起不来"时能把时钟问题和别的问题分开。
#>
param([switch]$Clean, [switch]$SlowClock, [switch]$Minimal)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$build = Join-Path $root 'build'
if ($SlowClock) { $Minimal = $true }        # 保命档只存在于寄存器版

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

$sdk = Join-Path $root 'sdk'
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

if ($Minimal){
  $sources = @(
    (Join-Path $root 'src\main.c'),
    (Join-Path $root 'src\startup.c'),
    (Join-Path $root 'segger_rtt\SEGGER_RTT.c')
  )
  if ($SlowClock){ $cflags += '-DHSI_64MHZ_ONLY=1' }
} else {
  # ---- HAL/SDK 版：源文件清单照抄 demo 的 keil 工程（去掉用不上的 USART/GPIO/BSP）----
  $hal = Join-Path $sdk 'Drivers\STM32H7xx_HAL_Driver\Src'
  $sources = @(
    (Join-Path $sdk 'Core\Src\main.c'),                     # ← 改过的：主循环换成 RTT 灌流
    (Join-Path $sdk 'Core\Src\stm32h7xx_it.c'),
    (Join-Path $sdk 'Core\Src\stm32h7xx_hal_msp.c'),
    (Join-Path $sdk 'Core\Src\system_stm32h7xx.c'),         # SystemInit / SystemCoreClock
    (Join-Path $root 'src\startup.c'),                      # 我们的 C 启动文件（向量表+SystemInit）
    (Join-Path $root 'segger_rtt\SEGGER_RTT.c')
  )
  foreach ($f in 'stm32h7xx_hal.c','stm32h7xx_hal_cortex.c','stm32h7xx_hal_rcc.c','stm32h7xx_hal_rcc_ex.c',
                 'stm32h7xx_hal_pwr.c','stm32h7xx_hal_pwr_ex.c','stm32h7xx_hal_flash.c','stm32h7xx_hal_flash_ex.c',
                 'stm32h7xx_hal_gpio.c','stm32h7xx_hal_exti.c'){
    $sources += (Join-Path $hal $f)
  }
  $cflags += @(
    '-DUSE_HAL_DRIVER', '-DSTM32H7B0xx',
    "-I$sdk\Core\Inc",
    "-I$sdk\Drivers\STM32H7xx_HAL_Driver\Inc",
    "-I$sdk\Drivers\STM32H7xx_HAL_Driver\Inc\Legacy",
    "-I$sdk\Drivers\CMSIS\Device\ST\STM32H7xx\Include",
    "-I$sdk\Drivers\CMSIS\Include"
  )
}

& $gcc @cflags @sources -o $elf
if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }

& $objcopy -O binary $elf (Join-Path $build 'fw.bin')
& $objcopy -O ihex   $elf (Join-Path $build 'fw.hex')
& $size $elf

Write-Output ""
Write-Output ("版本    ： {0}" -f $(if ($Minimal) { '寄存器版（无外部依赖）' } else { 'HAL/SDK 版（时钟配置 = 板子 demo 原样）' }))
Write-Output ("时钟    ： {0}" -f $(if ($SlowClock) { 'HSI 64MHz（保命档，完全不碰 PLL/VOS）' }
                                     elseif ($Minimal) { 'HSE 25MHz→PLL1 280MHz（VOS0）；无晶振自动退 HSI→PLL' }
                                     else { 'HSE 25MHz→PLL1 280MHz（VOS0）—— SystemClock_Config() 原文' }))
Write-Output ("产物    ： {0}" -f $elf)
Write-Output ("          {0} ({1} B)" -f (Join-Path $build 'fw.bin'), (Get-Item (Join-Path $build 'fw.bin')).Length)
Write-Output ""
Write-Output "下一步："
Write-Output "  烧录（OpenOCD 兜底）： pwsh -File flash.ps1"
Write-Output "  零安装烧录：在网页「烧录器」里选 stm32h7b0 → 选 build\fw.elf → 烧录"
Write-Output "  测速：网页 RTT Viewer 连上后看「读取 KB/s」；或 node tools\selftest\rtt-speed.mjs"
