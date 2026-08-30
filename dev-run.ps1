<#
.SYNOPSIS
    Runs the development build against an isolated data directory.

.DESCRIPTION
    RefleK's stores everything (runs, replays, settings, cache) under
    $HOME\.refleks, and resolves that path through Go's os.UserHomeDir(),
    which on Windows simply reads the USERPROFILE environment variable.

    Pointing USERPROFILE at a separate folder for this process alone moves
    the whole data directory with it. No source change is required, and the
    real .refleks folder stays untouched and unopened - an unfinished build
    cannot corrupt real runs it never has a path to.

    GOPATH is pinned back to the real profile so the Go module cache is not
    re-downloaded into the dev home (it defaults to %USERPROFILE%\go, which
    would otherwise follow the override).

.PARAMETER Watch
    Runs `wails dev` (hot reload) instead of the compiled binary.

.EXAMPLE
    .\dev-run.ps1
    .\dev-run.ps1 -Watch
#>
param([switch]$Watch)

$ErrorActionPreference = 'Stop'

$realHome = $env:USERPROFILE
$devHome = Join-Path $realHome 'refleks-devhome'
$repoRoot = $PSScriptRoot

if (-not (Test-Path $devHome)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $devHome '.refleks') | Out-Null
    Write-Host "Created empty dev data directory: $devHome" -ForegroundColor Yellow
}

# Keep the module cache in the real profile; only app data moves.
if (-not $env:GOPATH) { $env:GOPATH = Join-Path $realHome 'go' }
$env:USERPROFILE = $devHome

Write-Host "Data directory : $devHome\.refleks" -ForegroundColor Cyan
Write-Host "Real data      : $realHome\.refleks (untouched)" -ForegroundColor DarkGray

$logDir = Join-Path $devHome 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir ("refleks-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
Write-Host "Log            : $log" -ForegroundColor DarkGray

# Keep only the ten most recent logs.
Get-ChildItem $logDir -Filter 'refleks-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 |
    Remove-Item -Force -ErrorAction SilentlyContinue

# Redirected by cmd rather than by PowerShell. Sending a native program's
# stderr through 2>&1 in Windows PowerShell turns every line it writes into
# an error record, which paints the console red and can stop the script on
# output that was never a failure.
Write-Host "Follow it with: Get-Content -Wait `"$log`"" -ForegroundColor DarkGray

if ($Watch) {
    Set-Location $repoRoot
    # A dev build logs at DEBUG. The packaged build logs only ERROR, which
    # still carries "screen capture runtime failure" but none of the detail
    # around it.
    & cmd /c "wails dev > `"$log`" 2>&1"
} else {
    $exe = Join-Path $repoRoot 'build\bin\refleks.exe'
    if (-not (Test-Path $exe)) {
        throw "No build found at $exe - run 'wails build' first."
    }
    & cmd /c "`"$exe`" > `"$log`" 2>&1"
}
