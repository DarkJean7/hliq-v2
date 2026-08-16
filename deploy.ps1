param(
  # Also ship server.js + strategies/ and restart hliq-strat (the bot-control server).
  # Off by default so routine frontend deploys never disrupt running bots.
  [switch]$Bots
)

$key    = "$HOME\.ssh\hliq_key"
$server = "root@159.69.193.250"
$target = "/root/hliq-v2/"
$root   = "C:/Users/jeank/OneDrive/Desktop/hliq-v2"

# The server serves dist/, so src edits do nothing unless we build first.
Write-Host "Building..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed - aborting deploy" -ForegroundColor Red; exit 1 }

Write-Host "Uploading..." -ForegroundColor Cyan
ssh -i $key $server "mkdir -p $target"
scp -i $key -r "$root/src"           "${server}:${target}"
scp -i $key -r "$root/public"        "${server}:${target}"
scp -i $key -r "$root/dist"          "${server}:${target}"
scp -i $key    "$root/index.html"    "${server}:${target}"
scp -i $key    "$root/vite.config.js" "${server}:${target}"
# The pm2 processes run serve-prod.js (hliq-v2) and server.js (hliq-strat).
scp -i $key    "$root/serve-prod.js" "${server}:${target}"
scp -i $key    "$root/server.js"     "${server}:${target}"
# Bot-control server + strategy scripts. Always synced so files match, but the running
# bots only pick up strategy changes when hliq-strat restarts (see -Bots below).
scp -i $key -r "$root/strategies"    "${server}:${target}"

ssh -i $key $server "cd $target && pm2 restart hliq-v2"
if ($Bots) {
  Write-Host "Restarting hliq-strat (bot-control server + bots)..." -ForegroundColor Yellow
  ssh -i $key $server "cd $target && pm2 restart hliq-strat"
}
Write-Host "Deployed." -ForegroundColor Green
