# dsh-xlock.ps1 — 跨机会话粘锁插件 CLI 包装
#
# 用法（PowerShell 7+）：
#   dsh-xlock.ps1 audit   <session|all>
#   dsh-xlock.ps1 resolve <session> --keep primary|copy
#   dsh-xlock.ps1 reset   <session>
#   dsh-xlock.ps1 status
#   dsh-xlock.ps1 gc
#
# 前置：DSH 已安装（或手动指定 $env:DSH_NODE_EXECUTABLE）；
# 本脚本用 DSH 自带 Node（ELECTRON_RUN_AS_NODE=1）跑插件 CLI，零额外依赖。
# 规则：本文件 UTF-8 BOM + CRLF；不要用会改行尾的编辑器保存。

[CmdletBinding()]
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# ── 定位 DSH Node ────────────────────────────────────────────────────────
$node = $env:DSH_NODE_EXECUTABLE
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  $node = $null
  $candidates = @(
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
  }
}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  Write-Error 'DSH_NODE_EXECUTABLE 未设置且找不到 DeepSeek Harness.exe；请先启动 DSH 或手动指定环境变量'
  exit 2
}

# ── 定位插件 CLI ────────────────────────────────────────────────────────
$cli = Join-Path $PSScriptRoot 'cli\xlock.mjs'
if (-not (Test-Path -LiteralPath $cli)) {
  # 本脚本与 cli/ 同目录（源码态 dsh-plugins/dsh-xlock、安装态 node_modules/dsh-xlock 均成立）
  Write-Error "找不到 CLI：$cli"
  exit 2
}

$env:ELECTRON_RUN_AS_NODE = '1'
& $node $cli @Rest
exit $LASTEXITCODE
