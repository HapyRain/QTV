#!/usr/bin/env pwsh
# QTV for Windows 打包脚本（PowerShell 7+ / Windows 10+）
#
#   pwsh -NoProfile -File scripts/build-windows.ps1
#
# 流程：
#   1. 构建前端静态产物（同时同步 Windows / Android / iOS 三端资产）
#   2. 安装 Electron 依赖（已装则跳过；CI 用 npm ci）
#   3. electron-builder 产出 NSIS 安装包 + Portable 便携版
#
# 国内网络下载 Electron 慢时，可先设置镜像（CI 不需要）：
#   $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
#   $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent $PSScriptRoot
$WinDir = Join-Path $RootDir 'windows'

Write-Host '[1/3] 构建前端静态产物并同步到 windows/www ...' -ForegroundColor Cyan
node (Join-Path $PSScriptRoot 'build-web.mjs')
if ($LASTEXITCODE -ne 0) { throw 'build-web.mjs 失败' }

Write-Host '[2/3] 安装 Windows 宿主依赖 ...' -ForegroundColor Cyan
Push-Location $WinDir
try {
  if (-not (Test-Path 'node_modules\electron')) {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'windows 依赖安装失败' }
  }

  Write-Host '[3/3] 打包 NSIS 安装程序与 Portable 便携版 ...' -ForegroundColor Cyan
  npx electron-builder --win --x64
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder 失败' }
} finally {
  Pop-Location
}

Write-Host "[完成] 产物目录：$WinDir\dist" -ForegroundColor Green
Get-ChildItem (Join-Path $WinDir 'dist') -Filter '*.exe' -ErrorAction SilentlyContinue |
  ForEach-Object { '  {0}  {1:N1} MB' -f $_.Name, ($_.Length / 1MB) }
