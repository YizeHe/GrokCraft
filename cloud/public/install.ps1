# Grokcraft 安装：不会替换已有 Grok Build，也不会改它的环境变量。
# 用法：irm https://grokcraft.tanyuntech.cn/install.ps1 | iex

$ErrorActionPreference = "Stop"
$Origin = "https://grokcraft.tanyuntech.cn"
$InstallDir = Join-Path $env:LOCALAPPDATA "grokcraft"
$BinDir = Join-Path $InstallDir "bin"

function Find-GrokBuild {
  $cmd = Get-Command grok -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $homeBin = Join-Path $env:USERPROFILE ".grok\bin\grok.exe"
  if (Test-Path $homeBin) { return $homeBin }
  return $null
}

function Find-Pager {
  $candidates = @(
    (Join-Path $BinDir "xai-grok-pager.exe"),
    (Join-Path $BinDir "gcagent.exe"),
    $env:GROKCRAFT_PAGER,
    "D:\grokbuild\grokcraft\grok-build\target\release\xai-grok-pager.exe",
    "D:\grokbuild\grokcraft\grok-build\target\debug\xai-grok-pager.exe"
  ) | Where-Object { $_ }
  foreach ($p in $candidates) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

Write-Host "Grokcraft installer" -ForegroundColor Cyan
Write-Host "This does not replace Grok Build or change its settings." -ForegroundColor DarkGray
Write-Host ""

$grok = Find-GrokBuild
if (-not $grok) {
  Write-Host "Grok Build was not found." -ForegroundColor Red
  Write-Host "Install Grok Build first, then run this command again."
  Write-Host "Expected: grok on PATH, or $env:USERPROFILE\.grok\bin\grok.exe"
  exit 1
}
Write-Host "Grok Build: $grok"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$pager = Find-Pager
$destPager = Join-Path $BinDir "xai-grok-pager.exe"
if ($pager -and (Resolve-Path $pager).Path -ne (Join-Path $BinDir "xai-grok-pager.exe")) {
  Copy-Item -Force $pager $destPager
  Write-Host "Copied Grokcraft binary to $destPager"
} elseif (Test-Path $destPager) {
  Write-Host "Using existing $destPager"
} else {
  Write-Host "Grokcraft binary not found next to this machine's build output." -ForegroundColor Yellow
  Write-Host "Place xai-grok-pager.exe in $BinDir and run this installer again."
}

$gcagentCmd = Join-Path $BinDir "gcagent.cmd"
@"
@echo off
setlocal
set EXE=%LOCALAPPDATA%\grokcraft\bin\xai-grok-pager.exe
if exist "%EXE%" (
  "%EXE%" %*
  exit /b %ERRORLEVEL%
)
echo Grokcraft binary missing: %EXE%
echo Install Grok Build first, then rerun: irm $Origin/install.ps1 ^| iex
exit /b 1
"@ | Set-Content -Encoding ASCII -Path $gcagentCmd

$gcagentPs1 = Join-Path $BinDir "gcagent.ps1"
@"
`$exe = Join-Path `$env:LOCALAPPDATA 'grokcraft\bin\xai-grok-pager.exe'
if (-not (Test-Path `$exe)) { throw "Grokcraft binary missing: `$exe" }
& `$exe @args
"@ | Set-Content -Encoding UTF8 -Path $gcagentPs1

[Environment]::SetEnvironmentVariable("grokcraft", $InstallDir, "User")
[Environment]::SetEnvironmentVariable("gcagent", $gcagentCmd, "User")
$env:grokcraft = $InstallDir
$env:gcagent = $gcagentCmd

Write-Host ""
Write-Host "Installed launcher: $gcagentCmd"
Write-Host "User env grokcraft = $InstallDir"
Write-Host "User env gcagent   = $gcagentCmd"
Write-Host "Grok Build was left unchanged."
Write-Host ""
Write-Host "Open a new terminal, then start with:"
Write-Host "  & `$env:gcagent"
Write-Host "or"
Write-Host "  $gcagentCmd"
