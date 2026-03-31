# Lokal Agent Simulation Test
# Run in a new PowerShell while dashboard is open at http://localhost:3000

$API = "http://localhost:3000"
$h = @{ "Content-Type" = "application/json" }

Write-Host ""
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host "  LOKAL - Agent Simulation"               -ForegroundColor Cyan
Write-Host "  Hold dashboardet apent i nettleseren!"   -ForegroundColor Yellow
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host ""

# --- Scene 1: Consumer agent searches ---
Write-Host "[Agent: MatSmart AI] Soker etter gronnsaker i Oslo..." -ForegroundColor Blue
Start-Sleep -Seconds 2

$search1 = Invoke-RestMethod -Uri "$API/api/marketplace/search?q=ferske+gronnsaker+oslo" -Method Get
$count1 = $search1.count
Write-Host "  Fant $count1 produsenter:" -ForegroundColor Green

$top3 = $search1.results | Select-Object -First 3
foreach ($r in $top3) {
    $name = $r.agent.name
    $city = $r.agent.location.city
    $score = [math]::Round($r.relevanceScore * 100)
    Write-Host "    - $name ($city) - $score% match" -ForegroundColor White
}

Start-Sleep -Seconds 3

# --- Scene 2: Another agent searches for honey ---
Write-Host ""
Write-Host "[Agent: Honning-Finder] Soker etter honning..." -ForegroundColor Blue
Start-Sleep -Seconds 2

$search2 = Invoke-RestMethod -Uri "$API/api/marketplace/search?q=honning+oslo" -Method Get
$count2 = $search2.count
Write-Host "  Fant $count2 produsenter:" -ForegroundColor Green

$top3b = $search2.results | Select-Object -First 3
foreach ($r in $top3b) {
    $name = $r.agent.name
    $city = $r.agent.location.city
    $score = [math]::Round($r.relevanceScore * 100)
    Write-Host "    - $name ($city) - $score% match" -ForegroundColor White
}

Start-Sleep -Seconds 3

# --- Scene 3: A2A JSON-RPC request ---
Write-Host ""
Write-Host "[Agent: Claude Desktop MCP] Sender A2A JSON-RPC melding..." -ForegroundColor Blue
Start-Sleep -Seconds 2

$ts = Get-Date -Format "HHmmss"
$jsonrpcBody = @"
{"jsonrpc":"2.0","method":"message/send","params":{"message":{"text":"finn lokale egg og meieriprodukter"},"agentId":"claude-desktop-test"},"id":"mcp-$ts"}
"@

$a2a = Invoke-RestMethod -Uri "$API/a2a" -Method Post -Headers $h -Body $jsonrpcBody
$taskStatus = $a2a.result.task.status
$a2aCount = $a2a.result.artifacts[0].data.count
Write-Host "  Task status: $taskStatus" -ForegroundColor Green
Write-Host "  Resultater: $a2aCount agenter funnet" -ForegroundColor Green

Start-Sleep -Seconds 3

# --- Scene 4: Start a conversation ---
$sellerId = $search1.results[0].agent.id
$sellerName = $search1.results[0].agent.name

Write-Host ""
Write-Host "[Agent: MatSmart AI] Starter samtale med $sellerName..." -ForegroundColor Blue
Start-Sleep -Seconds 2

$convBody = @"
{"buyerAgentId":"matsmart-ai-agent-001","sellerAgentId":"$sellerId","queryText":"Trenger 10 kg gronnsaker til restaurant"}
"@

$conv = Invoke-RestMethod -Uri "$API/api/conversations" -Method Post -Headers $h -Body $convBody
$convId = $conv.data.id
$convStatus = $conv.data.status
Write-Host "  Samtale startet! Status: $convStatus" -ForegroundColor Green

$sysMsg = $conv.data.messages[0].content
if ($sysMsg.Length -gt 80) { $sysMsg = $sysMsg.Substring(0, 80) + "..." }
Write-Host "  System: $sysMsg" -ForegroundColor DarkGray

Start-Sleep -Seconds 3

# --- Scene 5: Seller responds with offer ---
Write-Host ""
Write-Host "[Agent: $sellerName] Sender tilbud..." -ForegroundColor Magenta
Start-Sleep -Seconds 2

$offerBody = @"
{"senderRole":"seller","senderAgentId":"$sellerId","content":"Vi har ferske gronnsaker: tomater 45kr/kg, agurk 32kr/kg, paprika 55kr/kg. Levering innen 2 timer.","messageType":"offer","metadata":{"deliveryTime":"2 timer"}}
"@

$offer = Invoke-RestMethod -Uri "$API/api/conversations/$convId/messages" -Method Post -Headers $h -Body $offerBody
Write-Host "  Tilbud sendt: $($offer.data.content)" -ForegroundColor Green

Start-Sleep -Seconds 3

# --- Scene 6: Buyer accepts ---
Write-Host ""
Write-Host "[Agent: MatSmart AI] Aksepterer tilbudet!" -ForegroundColor Blue
Start-Sleep -Seconds 1

$acceptBody = @"
{"senderRole":"buyer","senderAgentId":"matsmart-ai-agent-001","content":"Perfekt! Bestiller 3kg tomater, 2kg agurk, 2kg paprika. Lever til Torggata 15, Oslo.","messageType":"accept"}
"@

$accept = Invoke-RestMethod -Uri "$API/api/conversations/$convId/messages" -Method Post -Headers $h -Body $acceptBody
Write-Host "  Bestilling bekreftet!" -ForegroundColor Green

Start-Sleep -Seconds 2

# --- Scene 7: Complete the transaction ---
Write-Host ""
Write-Host "[System] Fullforer transaksjon..." -ForegroundColor Yellow

$completeBody = '{"totalAmountNok":309,"products":["Tomater 3kg","Agurk 2kg","Paprika 2kg"]}'

$complete = Invoke-RestMethod -Uri "$API/api/conversations/$convId/complete" -Method Post -Headers $h -Body $completeBody
$finalStatus = $complete.data.status
$msgCount = $complete.data.messages.Count
Write-Host "  Status: $finalStatus" -ForegroundColor Green
Write-Host "  Totalbelop: 309 NOK" -ForegroundColor Green
Write-Host "  Meldinger i samtalen: $msgCount" -ForegroundColor Green

Start-Sleep -Seconds 2

# --- Scene 8: More search activity ---
Write-Host ""
Write-Host "[Agent: FiskElansen] Soker fisk og sjomat..." -ForegroundColor Blue
Start-Sleep -Seconds 1
$s3 = Invoke-RestMethod -Uri "$API/api/marketplace/search?q=fersk+fisk+laks+oslo" -Method Get
Write-Host "  Fant $($s3.count) agenter" -ForegroundColor Green

Start-Sleep -Seconds 1

Write-Host "[Agent: BakerBot] Soker bakervarer..." -ForegroundColor Blue
$s4 = Invoke-RestMethod -Uri "$API/api/marketplace/search?q=brod+bakervarer" -Method Get
Write-Host "  Fant $($s4.count) agenter" -ForegroundColor Green

Start-Sleep -Seconds 2

# --- Final Stats ---
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  RESULTATER"                             -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$stats = Invoke-RestMethod -Uri "$API/api/interactions/stats" -Method Get
Write-Host "  Interaksjoner totalt: $($stats.data.totalInteractions)" -ForegroundColor White
Write-Host "  Sok i dag: $($stats.data.searchesToday)" -ForegroundColor White

$convList = Invoke-RestMethod -Uri "$API/api/conversations" -Method Get
Write-Host "  Samtaler: $($convList.count)" -ForegroundColor White

$metrics = Invoke-RestMethod -Uri "$API/api/agents/$sellerId/metrics" -Method Get
$mName = $metrics.data.agentName
Write-Host ""
Write-Host "  Selger-metrics for $mName :" -ForegroundColor Yellow
Write-Host "    Funnet i sok: $($metrics.data.timesDiscovered) ganger" -ForegroundColor White
Write-Host "    Kontaktet: $($metrics.data.timesContacted) ganger" -ForegroundColor White
Write-Host "    Handler fullfort: $($metrics.data.timesChosen)" -ForegroundColor White
Write-Host "    Omsetning: $($metrics.data.totalRevenueNok) NOK" -ForegroundColor White

Write-Host ""
Write-Host "  Sjekk dashboardet na!" -ForegroundColor Green
Write-Host "    - Live Feed: viser alle hendelser" -ForegroundColor Gray
Write-Host "    - Samtaler: viser hele dialogen" -ForegroundColor Gray
Write-Host "    - Topp Selgere: viser metrics" -ForegroundColor Gray
Write-Host ""
