<#
  只清理靶子固件的生成目录。
  -List    只列出将处理的目录，不修改文件
  -WhatIf  按 PowerShell 语义预览删除

  保护范围：不会删除源码、根目录入库的 fw.elf、文档、tmp 或 bundle。
#>
param([switch]$List, [switch]$WhatIf)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$firmwareRoot = [IO.Path]::GetFullPath((Join-Path $repo 'tools/target-firmware'))
$prefix = $firmwareRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

$targets = @(
  Get-ChildItem -LiteralPath $firmwareRoot -Directory -Force |
    ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue } |
    Where-Object { $_.Name -eq 'build' -or $_.Name -like 'build-*' }
)

if (-not $targets) {
  Write-Output '没有发现靶子固件生成目录。'
  exit 0
}

foreach ($target in $targets) {
  $full = [IO.Path]::GetFullPath($target.FullName)
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝处理越出固件目录的路径：$full"
  }
  $size = (Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  Write-Output ("{0}  ({1:N0} B)" -f $full.Substring($repo.Length + 1), $size)
  if (-not $List) { Remove-Item -LiteralPath $full -Recurse -Force -WhatIf:$WhatIf }
}

if ($List) { Write-Output '仅列出，未修改文件。' }
elseif ($WhatIf) { Write-Output 'WhatIf 预览完成，未修改文件。' }
else { Write-Output ("已清理 {0} 个靶子固件生成目录。" -f $targets.Count) }
