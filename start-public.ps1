# ─── Lokal: Start med Cloudflare Tunnel ──────────────────────
# Starter serveren lokalt OG eksponerer den til internett.
# Agenter verden over kan finne deg via Agent Card-URL-en.
#
# Forutsetning: cloudflared er installert.
# Installer: winget install Cloudflare.cloudflared
#   eller:   choco install cloudflared
#   eller:   last ned fra https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Write-Host ""
Write-Host "=== Lokal: Starting public A2A server ===" -ForegroundColor Green
Write-Host ""

# Sjekk at cloudflared finnes
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
    Write-Host "cloudflared er ikke installert." -ForegroundColor Red
    Write-Host ""
    Write-Host "Installer med EN av disse:" -ForegroundColor Yellow
    Write-Host "  winget install Cloudflare.cloudflared"
    Write-Host "  choco install cloudflared"
    Write-Host "  Eller last ned: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    Write-Host ""
    exit 1
}

Write-Host "[1/3] Starter Lokal-serveren..." -ForegroundColor Cyan

# Start serveren i bakgrunnen
$serverJob = Start-Job -ScriptBlock {
    Set-Location $using:PWD
    npx tsx src/index.ts 2>&1
}

# Vent litt til serveren er oppe
Start-Sleep -Seconds 4

# Sjekk at serveren kjorer
try {
    $health = Invoke-RestMethod -Uri "http://localhost:3000/health" -TimeoutSec 5
    Write-Host "[OK] Server kjorer - $($health.agents) agenter lastet" -ForegroundColor Green
} catch {
    Write-Host "[FEIL] Serveren startet ikke. Sjekk at port 3000 er ledig." -ForegroundColor Red
    Stop-Job $serverJob
    Remove-Job $serverJob
    exit 1
}

Write-Host ""
Write-Host "[2/3] Starter Cloudflare Tunnel..." -ForegroundColor Cyan
Write-Host "       (dette gir deg en offentlig URL - ingen konto trengs)" -ForegroundColor Gray
Write-Host ""

# Start cloudflared og fang URL-en
$tunnelProc = Start-Process -FilePath "cloudflared" `
    -ArgumentList "tunnel", "--url", "http://localhost:3000" `
    -RedirectStandardError "$env:TEMP\cloudflared-output.txt" `
    -PassThru -NoNewWindow

# Vent pa at tunnel-URL-en dukker opp i output
$publicUrl = $null
$attempts = 0
while (-not $publicUrl -and $attempts -lt 30) {
    Start-Sleep -Seconds 1
    $attempts++
    if (Test-Path "$env:TEMP\cloudflared-output.txt") {
        $output = Get-Content "$env:TEMP\cloudflared-output.txt" -Raw
        if ($output -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
            $publicUrl = $matches[1]
        }
    }
}

if (-not $publicUrl) {
    Write-Host "[FEIL] Kunne ikke hente tunnel-URL. Sjekk at cloudflared fungerer." -ForegroundColor Red
    Write-Host "       Prov manuelt: cloudflared tunnel --url http://localhost:3000" -ForegroundColor Yellow
    Stop-Job $serverJob
    Stop-Process -Id $tunnelProc.Id -ErrorAction SilentlyContinue
    exit 1
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "[3/3] LOKAL ER LIVE!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Offentlig URL:   $publicUrl" -ForegroundColor White
Write-Host ""
Write-Host "  Agent Card:      $publicUrl/.well-known/agent.json" -ForegroundColor Cyan
Write-Host "  A2A Endpoint:    $publicUrl/a2a" -ForegroundColor Cyan
Write-Host "  Dashboard:       $publicUrl" -ForegroundColor Cyan
Write-Host "  Health:          $publicUrl/health" -ForegroundColor Cyan
Write-Host ""
Write-Host "  NB: Live Feed (SSE) fungerer kun lokalt:" -ForegroundColor Yellow
Write-Host "       http://localhost:3000" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Del denne URL-en med agenter:" -ForegroundColor Gray
Write-Host "  $publicUrl/.well-known/agent.json" -ForegroundColor White
Write-Host ""
Write-Host "  Trykk Ctrl+C for aa stoppe alt." -ForegroundColor Gray
Write-Host ""

# Hold scriptet kjorende og vis server-logger
try {
    while ($true) {
        # Vis server output
        $output = Receive-Job $serverJob 2>$null
        if ($output) { $output | ForEach-Object { Write-Host "  [server] $_" -ForegroundColor DarkGray } }
        Start-Sleep -Seconds 2
    }
} finally {
    Write-Host ""
    Write-Host "Stopper..." -ForegroundColor Yellow
    Stop-Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob -ErrorAction SilentlyContinue
    Stop-Process -Id $tunnelProc.Id -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\cloudflared-output.txt" -ErrorAction SilentlyContinue
    Write-Host "Lokal stoppet." -ForegroundColor Gray
}
