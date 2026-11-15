#!/usr/bin/env pwsh
# QTV for Windows 一键启动脚本 (PowerShell 7+)
# 若本地已安装 Electron 则启动原生 Mica 宿主；否则直接启动本地 API 引擎并拉起 Edge/Chrome 无边框 App 模式窗口。

$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent $PSScriptRoot
$WinDir = Join-Path $RootDir 'windows'

if (Test-Path (Join-Path $WinDir 'node_modules\.bin\electron.cmd')) {
  Push-Location $WinDir
  try {
    & .\node_modules\.bin\electron.cmd .
  } finally {
    Pop-Location
  }
  exit 0
}

$Port = 18689
$ServerJob = Start-Process -FilePath "node" -ArgumentList @((Join-Path $WinDir 'local-api-server.mjs'), "$Port") -PassThru -WindowStyle Hidden

Start-Sleep -Milliseconds 650

$EdgePaths = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
)
$Browser = $EdgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($Browser) {
  Start-Process -FilePath $Browser -ArgumentList @("--app=http://127.0.0.1:$Port", "--window-size=1440,900") -Wait
  Stop-Process -Id $ServerJob.Id -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "QTV Local Engine running at http://127.0.0.1:$Port"
  Start-Process "http://127.0.0.1:$Port"
  Wait-Process -Id $ServerJob.Id
}
