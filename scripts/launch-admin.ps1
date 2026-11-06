param(
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

if (-not $Elevated) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $self = $PSCommandPath
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $self + '" -Elevated'
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs
    exit 0
  }
}

$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root '.whale-home'
$runtime = Join-Path $data 'desktop-runtime\node_modules\electron\dist\electron.exe'
$main = Join-Path $root 'desktop\main.cjs'
if (-not (Test-Path -LiteralPath $runtime)) { throw "Electron runtime not found: $runtime" }

try { & node (Join-Path $PSScriptRoot 'local-stop.mjs') | Out-Host } catch {}
try { Remove-Item -LiteralPath (Join-Path $data 'runtime.json') -Force -ErrorAction SilentlyContinue } catch {}

function Start-WhaleTask([string]$extra) {
  $taskName = 'WhaleAdmin'
  $action = '"' + $runtime + '" "' + $main + '" "--whale-data=' + $data + '" --supervised ' + $extra
  & schtasks.exe /End /TN $taskName 2>$null | Out-Null
  & schtasks.exe /Create /TN $taskName /TR $action /SC ONCE /ST 23:59 /F /RL HIGHEST /IT | Out-Host
  if ($LASTEXITCODE -ne 0) { return $false }
  & schtasks.exe /Run /TN $taskName | Out-Host
  if ($LASTEXITCODE -ne 0) { return $false }
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $info = Get-Content -LiteralPath (Join-Path $data 'runtime.json') -Raw | ConvertFrom-Json
      if ($info.pid -and (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) { return $true }
    } catch {}
  }
  return $false
}

# First try the normal Chromium sandbox at HIGH integrity. If this machine's
# sandbox still cannot initialize, fall back to --no-sandbox (Low integrity).
if (-not (Start-WhaleTask '')) {
  Write-Host 'Normal sandbox did not start; retrying in compatibility mode.'
  & schtasks.exe /End /TN 'WhaleAdmin' 2>$null | Out-Null
  if (-not (Start-WhaleTask '--no-sandbox')) { throw 'BigFatFish did not start.' }
}

Write-Host 'BigFatFish is running through Task Scheduler. Closing this PowerShell window will not close it.'
