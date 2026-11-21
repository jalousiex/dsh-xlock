# dsh-xlock — 在另一台机器上把 dsh-xlock 装入 DSH profile（源码安装）。
#
# 用法（对机 PowerShell，在 ~/.dsh/dsh-plugins/dsh-xlock 目录内执行）：
#   powershell -ExecutionPolicy Bypass -File .\install-into-profile.ps1 [-ProfileName desktop] [-DshRoot 'D:\Program Files\DeepSeek Harness']
#
# 前提：
#   1. ~/.dsh/dsh-plugins/dsh-xlock 已由同步盘带到本机（本脚本就在包内）。
#   2. 对机装有 DeepSeek Harness（desktop profile）。
#
# 做的事（幂等，可重复运行）：
#   1. profiles\<ProfileName>\package.json 登记 dsh-xlock（dependencies + dsh.profile.bundles 双处）；
#   2. 用 DSH 自带 runtime（resources\runtime）+ vendored pnpm 执行 pnpm install；
#      spec 用 npm 纯 semver 范围 ^0.2.8（从 registry 装，不依赖本机源码目录就位；
#      不要用 github: 形态——DSH 原生更新检测只认 registry 安装）；
#   3. 提示完全退出并重启 DSH 激活。
param(
  [string]$ProfileName = 'desktop',
  [string]$DshRoot = ''
)
$ErrorActionPreference = 'Stop'

# ── 1) 源与 profile 定位 ────────────────────────────────────────────────
$pluginDir  = Join-Path $env:USERPROFILE '.dsh\dsh-plugins\dsh-xlock'
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName"
$pkgPath    = Join-Path $profileDir 'package.json'
if (-not (Test-Path (Join-Path $pluginDir 'index.js'))) {
  throw "插件源缺失：$pluginDir（同步盘没挂载？）"
}
if (-not (Test-Path $pkgPath)) {
  throw "profile 不存在：$pkgPath（对机先装好 DSH 并至少启动过一次）"
}

# ── 2) package.json 登记（JSON 文本安全改写，保留格式）───────────────────
# 用 DSH runtime 的 node 改（避免 PS5.1 ConvertTo-Json 单元素数组塌缩陷阱）。
$node = $env:DSH_NODE_EXECUTABLE
if (-not $node -or -not (Test-Path $node)) {
  if (-not $DshRoot) {
    foreach ($c in @('D:\Program Files\DeepSeek Harness', 'C:\Program Files\DeepSeek Harness', "$env:LOCALAPPDATA\Programs\DeepSeek Harness")) {
      if (Test-Path $c) { $DshRoot = $c; break }
    }
  }
  if (-not $DshRoot) { throw '定位不到 DSH 安装根，请用 -DshRoot 指定（DeepSeek Harness.exe 所在目录）' }
  $node = Join-Path $DshRoot 'DeepSeek Harness.exe'
}
if (-not (Test-Path $node)) { throw "node 不可用：$node" }
# pnpm 在 DSH 根下：env 变量给了 node 而没给根时，从 node 路径推导。
if (-not $DshRoot) { $DshRoot = Split-Path -Parent $node }

$editScript = @'
const fs = require('fs');
const p = process.argv[1];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.dependencies = j.dependencies || {};
if (j.dependencies['dsh-xlock'] !== '^0.2.8') {
  j.dependencies['dsh-xlock'] = '^0.2.8';
}
if (!j.dsh || !j.dsh.profile) throw new Error('package.json lacks dsh.profile section — DSH version mismatch?');
j.dsh.profile.bundles = j.dsh.profile.bundles || [];
if (!j.dsh.profile.bundles.includes('dsh-xlock')) j.dsh.profile.bundles.push('dsh-xlock');
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
console.log('package.json updated: ' + p);
'@
$env:ELECTRON_RUN_AS_NODE = '1'
& $node -e $editScript $pkgPath
# 不依赖 $LASTEXITCODE（GUI 子系统缓冲下可能为空）——直接验内容。
if (-not (Select-String -Path $pkgPath -Pattern '"dsh-xlock"\s*:' -Quiet)) {
  throw "package.json 改写失败（未找到 dsh-xlock 条目）"
}

# ── 3) pnpm install（DSH 自带 vendored pnpm）────────────────────────────
$pnpm = Join-Path $DshRoot 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
if (-not (Test-Path $pnpm)) { throw "DSH 自带 pnpm 缺失：$pnpm（DSH 版本不含 primary-runtime？改用全局 pnpm 手动安装）" }
& $node $pnpm -C $profileDir install
# 同上：以安装产物为准验成（$LASTEXITCODE 仅在为数字时参与判断）。
$installedIndex = Join-Path $profileDir 'node_modules\dsh-xlock\index.js'
if (-not (Test-Path $installedIndex)) {
  throw "pnpm install 失败（node_modules\dsh-xlock\index.js 未出现；exit=$LASTEXITCODE）"
}

Write-Host ''
Write-Host 'dsh-xlock 已装入 profile。请完全退出并重启 DeepSeek Harness 以激活。'
Write-Host '验证：%LOCALAPPDATA%\dsh-xlock\host.log 应出现 "apply entered / inject fired / wrapping"。'
