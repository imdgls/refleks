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

if ($Watch) {
    Set-Location $repoRoot
    wails dev
} else {
    $exe = Join-Path $repoRoot 'build\bin\refleks.exe'
    if (-not (Test-Path $exe)) {
        throw "No build found at $exe - run 'wails build' first."
    }
    & $exe
}
