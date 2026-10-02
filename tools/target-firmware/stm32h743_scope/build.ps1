<#
  STM32H743 · J-Scope 采样靶子固件编译脚本（不需要 make，也不需要 Keil）

    pwsh -File build.ps1                # 默认：flash 版 → build\fw.elf（并复制一份到本目录 fw.elf）
    pwsh -File build.ps1 -DCache        # ★ "H7 D-cache 干扰"实验版：-DDCACHE_ON=1 → build-dcache\fw.elf
    pwsh -File build.ps1 -Ram           # 全 RAM 版（本机这块 H743 的 flash 算法跑不起来时用）→ build-ram\fw_ram.elf
    pwsh -File build.ps1 -Clean

  依赖：arm-none-eabi-gcc 在 PATH 里（本机在 E:\Share\env-windows\tools\gnu_gcc\arm_gcc\mingw\bin）

  三个版本为什么要分开：
    · 默认版   —— .data/.bss 在 AXI SRAM、栈在 DTCM、D-Cache 关（AHB-AP 读到的是真内存）。
    · -DCache  —— 同一份源码，只是 main() 里把 SCB.CCR 的 D-Cache 位打开。开/关各采一遍，
                  就能看出"探针读到的是不是 cache 里的旧值/干脆冻住不动"。产物**故意不覆盖**
                  默认的 fw.elf（默认产物才是仓库给用户下载的那一份）。
    · -Ram     —— 阿波罗 H743 那块板的 flash 算法跑不起来（见 ../stm32h743_rtt_speed/README.md），
                  这一版把整个镜像放进 AXI SRAM，用 AHB-AP 写进去 + 把 SP/PC 指过来跑。
#>
param([switch]$Clean, [switch]$DCache, [switch]$Ram)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$outName = 'build'
if ($Ram)    { $outName = 'build-ram' }
if ($DCache) { $outName = $(if ($Ram) { 'build-ram-dcache' } else { 'build-dcache' }) }
$build = Join-Path $root $outName
$ldpath = Join-Path $root $(if ($Ram) { 'ld\stm32h743_ram.ld' } else { 'ld\stm32h743.ld' })
if (-not (Test-Path $ldpath)) { throw "找不到链接脚本 $ldpath" }

$gcc = (Get-Command arm-none-eabi-gcc -ErrorAction SilentlyContinue).Source
if (-not $gcc){
  $guess = 'E:\Share\env-windows\tools\gnu_gcc\arm_gcc\mingw\bin\arm-none-eabi-gcc.exe'
  if (Test-Path $guess){ $gcc = $guess } else { throw 'arm-none-eabi-gcc 不在 PATH 里' }
}
$bin = Split-Path -Parent $gcc
$objcopy = Join-Path $bin 'arm-none-eabi-objcopy.exe'
$size    = Join-Path $bin 'arm-none-eabi-size.exe'
$nm      = Join-Path $bin 'arm-none-eabi-nm.exe'

if ($Clean -and (Test-Path $build)) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $build | Out-Null

$sources = @(
  (Join-Path $root 'src\main.c'),
  (Join-Path $root 'src\startup.c')
)
$elf = Join-Path $build $(if ($Ram) { 'fw_ram.elf' } else { 'fw.elf' })

# 参数一律加引号并用数组 splat：
# PowerShell 会把 -specs=nano.specs 按点号拆成两段（"-specs=nano" + ".specs"），
# 直接导致 "cannot read spec file 'nano'"。这是兄弟例程第一版踩的坑。
#
# -gdwarf-4 是**故意写死的**：scope 页面第一版的 DWARF 解析器只吃 DWARF 4
# （本机 GCC 10.3 默认也是 4，但 GCC 11+ 会默认切到 5 —— 显式写死免得工具链一升级就解析不出来）。
$cflags = @(
  '-mcpu=cortex-m7', '-mthumb', '-mfpu=fpv5-d16', '-mfloat-abi=hard',
  '-Os', '-g3', '-gdwarf-4',
  '-ffunction-sections', '-fdata-sections', '-fno-common',
  '-Wall', '-Wextra', '-Wno-unused-parameter',
  "-I$root\src",
  "-T$ldpath",
  '-nostartfiles', '-specs=nano.specs', '-specs=nosys.specs',
  '-Wl,--gc-sections', "-Wl,-Map=$build\fw.map"
)
if ($DCache) { $cflags += '-DDCACHE_ON=1' }

& $gcc @cflags @sources -o $elf
if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }

$binout = Join-Path $build $(if ($Ram) { 'fw_ram.bin' } else { 'fw.bin' })
$hexout = Join-Path $build $(if ($Ram) { 'fw_ram.hex' } else { 'fw.hex' })
& $objcopy -O binary $elf $binout
& $objcopy -O ihex   $elf $hexout
& $size $elf

Write-Output ""
Write-Output ("版本    ： {0}" -f $(if ($Ram) { '全 RAM 版（AXI SRAM 运行；flash 算法跑不起来时用）' } else { 'flash 版' }))
Write-Output ("D-Cache ： {0}" -f $(if ($DCache) { '**开**（-DDCACHE_ON=1）—— 这是 H7 D-cache 干扰实验版' } else { '关（默认；AHB-AP 读到的是真内存）' }))
Write-Output ("链接脚本： {0}" -f $ldpath)

# 把被采样变量的地址打印出来 —— 手填地址/排障时不用再开 nm。
# 本固件的硬要求：**所有 g_* 都必须是 0x24xxxxxx（AXI SRAM）**，DTCM(0x20000000) 探针读不到。
Write-Output ""
Write-Output "被采样变量（nm 实测地址/大小；必须全部落在 0x24xxxxxx = AXI SRAM）："
& $nm -S --size-sort $elf | Select-String -Pattern '\sg_' |
  ForEach-Object { "  " + $_.Line.Trim() }

# 编译成功后额外把 ELF 复制一份到本目录根 —— 这是本仓库给用户下载的约定
# （hpm6800evk_rtt_flood/fw.elf、stm32h743_rtt_speed/fw.elf 都是这么放的；
#   而 build*/ 被 .gitignore 忽略，所以只有根上这一份会进仓库）。
$keep = $null
if ($Ram -and -not $DCache)     { $keep = 'fw_ram.elf' }
elseif (-not $Ram -and -not $DCache) { $keep = 'fw.elf' }
if ($keep){
  Copy-Item $elf (Join-Path $root $keep) -Force
  Write-Output ""
  Write-Output ("已复制给用户下载： {0}" -f (Join-Path $root $keep))
} else {
  Write-Output ""
  Write-Output "（本变体产物留在构建目录里，不覆盖仓库根上那份默认 fw.elf）"
}
Write-Output ""
Write-Output ("产物： {0}" -f $elf)
Write-Output ("       {0} ({1} B)" -f $binout, (Get-Item $binout).Length)
