# Build the HPM6800EVK RTT flood firmware (HPM6880, RISC-V) with the HPM SDK env.
#
#   powershell -File script_test\hpm6800evk_rtt_flood\build.ps1 [-BuildType flash_xip]
#
# Output: build\<build_type>\output\hpm6800evk_rtt_flood.elf / .bin / .hex
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
& cmake -G Ninja -DBOARD=hpm6800evk -DHPM_BUILD_TYPE=$buildType -DCMAKE_BUILD_TYPE=debug -B $bdir -S $here
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build $bdir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$elf = Join-Path $bdir 'output\hpm6800evk_rtt_flood.elf'
if (Test-Path $elf) {
    $nm = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win\bin\riscv32-unknown-elf-nm.exe"
    Write-Output ""
    Write-Output "RTT control block:"
    & $nm -S $elf | Select-String '_SEGGER_RTT'
}
