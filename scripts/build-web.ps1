# 前端静态导出 → Android 资产（PowerShell 薄封装，实际逻辑在 build-web.mjs）
#
#   powershell -File scripts/build-web.ps1
#
# 需要 Node.js 18+；跨平台等价命令：node scripts/build-web.mjs
$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'build-web.mjs')
exit $LASTEXITCODE
