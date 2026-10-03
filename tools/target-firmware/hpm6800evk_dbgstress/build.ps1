# Build the HPM6800EVK debugger stress fixture (HPM6880, RISC-V) with the HPM SDK env.
#
#   pwsh -File build.ps1                # 默认 flash_xip
#   pwsh -File build.ps1 -BuildType ram # 需要时换构建类型
#
# 产物：build\<build_type>\output\demo.elf（SDK 统一叫 demo.elf；末尾会把它复制成
#      本目录的 fw.elf，方便直接烧/直接喂给调试器页）
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdkEnv = if ($env:HPM_SDK_ENV_DIR) { $env:HPM_SDK_ENV_DIR } else { 'E:\sdk_env_v1.11.0' }
$buildType = 'flash_xip'
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq '-BuildType' -and $i + 1 -lt $args.Count) { $buildType = $args[$i + 1] }
}

$env:PATH = "$sdkEnv\tools\python3;$sdkEnv\tools\cmake\bin;$sdkEnv\tools\ninja;$env:PATH"
$env:HPM_SDK_BASE = "$sdkEnv\hpm_sdk"
$env:GNURISCV_TOOLCHAIN_PATH = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win"
$env:HPM_SDK_TOOLCHAIN_VARIANT = 'gcc'

$bdir = Join-Path $here "build\$buildType"
Write-Output "building $buildType -> $bdir"
# ⚠️ 参数必须**加引号**：PowerShell 7 把以 `-` 开头的裸 token 当参数名，里面的
#    $buildType 不做变量展开（原样传给 cmake，SDK 会报 invalid HPM_BUILD_TYPE: $buildtype）。
& cmake -G Ninja "-DBOARD=hpm6800evk" "-DHPM_BUILD_TYPE=$buildType" "-DCMAKE_BUILD_TYPE=debug" -B $bdir -S $here
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build $bdir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$elf = Join-Path $bdir 'output\demo.elf'
$out = Join-Path $here 'fw.elf'
if (Test-Path $elf) {
    Copy-Item $elf $out -Force
    $nm = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win\bin\riscv32-unknown-elf-nm.exe"
    Write-Output ""
    Write-Output "关键符号（调试器页/压测脚本按这些名字下断点）："
    & $nm -S $elf | Select-String 'g_model|g_ticks|g_loops|g_stage|g_checksum|g_seq_slot|engine_|deep_l|is_even|is_odd|fn_|model_'
    Write-Output ""
    Write-Output ("已复制给用户下载/烧录： {0}" -f $out)
}
