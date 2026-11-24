# Build, sign (Tizen developer profile), install and launch device probe 2 on the TV.
# Usage: powershell -ExecutionPolicy Bypass -File probe2\tools\build-install.ps1 [-Profile probe-tizen] [-NoInstall]
param([string]$Profile = 'probe-tizen', [switch]$NoInstall)
$ErrorActionPreference = 'Stop'
$tz  = 'C:\Development\Tizen\sdk\tools\ide\bin\tizen.bat'
$tv  = '192.168.1.19:26101'
$src = Join-Path $PSScriptRoot '..\app' | Resolve-Path
$out = Join-Path $PSScriptRoot '..\dist'

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
Copy-Item $src $out -Recurse
& $tz build-web -- $out | Select-Object -Last 1
& $tz package -t wgt -s $Profile -- "$out\.buildResult" | Select-Object -Last 1
Rename-Item "$out\.buildResult\ScreenShelf Probe 2.wgt" 'SSProbe2.wgt'
if ($NoInstall) { return }
& $tz install -s $tv --name SSProbe2.wgt -- "$out\.buildResult" | Select-Object -Last 2
& $tz run -s $tv -p SSProbe002.Probe2 | Select-Object -Last 1
