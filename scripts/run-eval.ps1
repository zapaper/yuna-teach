#!/usr/bin/env pwsh
# Convenience wrapper for run-marking-eval.ts.
#
# Reads the yuna_session cookie from eval/cookie.txt (cached across
# runs so you don't paste it every time). If the file is missing or
# empty, prompts for the cookie and saves it. eval/cookie.txt is
# gitignored.
#
# Usage:
#   .\scripts\run-eval.ps1                    # full eval, all corpus
#   .\scripts\run-eval.ps1 --cleanup          # delete clones after
#   .\scripts\run-eval.ps1 --paper=cmpj...    # single paper
#
# Pass any of run-marking-eval.ts's flags through verbatim.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CookieFile = Join-Path $RepoRoot "eval\cookie.txt"
$RemoteBase = "https://www.markforyou.com"

# Read or prompt for the cookie.
$cookie = $null
if (Test-Path $CookieFile) {
    $cookie = (Get-Content $CookieFile -Raw).Trim()
}
if (-not $cookie) {
    Write-Host ""
    Write-Host "No cached cookie found at $CookieFile."
    Write-Host ""
    Write-Host "Grab your yuna_session cookie:"
    Write-Host "  1. Open $RemoteBase in your browser (logged in as admin)"
    Write-Host "  2. F12 -> Application -> Cookies -> yuna_session"
    Write-Host "  3. Copy the Value column"
    Write-Host ""
    $cookie = Read-Host "Paste yuna_session value"
    $cookie = $cookie.Trim()
    if (-not $cookie) {
        Write-Error "Empty cookie. Aborting."
        exit 1
    }
    # Cache for next time.
    New-Item -ItemType Directory -Force -Path (Split-Path $CookieFile) | Out-Null
    Set-Content -Path $CookieFile -Value $cookie -Encoding UTF8 -NoNewline
    Write-Host "Cached cookie to $CookieFile (gitignored)."
}

# Run the eval.
$env:EVAL_REMOTE_BASE = $RemoteBase
$env:EVAL_SESSION_COOKIE = $cookie
Write-Host ""
Write-Host "Running eval against $RemoteBase ..."
Write-Host ""
Push-Location $RepoRoot
try {
    & npx tsx scripts/run-marking-eval.ts @args
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($exitCode -ne 0) {
    Write-Host ""
    Write-Host "Eval exited with code $exitCode."
    Write-Host "If you see 'fetched=0' everywhere, the cookie is stale — delete eval\cookie.txt and re-run."
}
exit $exitCode
