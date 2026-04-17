$scriptPath  = "C:\Users\jeank\OneDrive\Desktop\hliq\watch.ps1"
$startupPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\hliq-watcher.bat"

# Write a .bat to the startup folder
@"
@echo off
powershell -ExecutionPolicy Bypass -WindowStyle Minimized -File "$scriptPath"
"@ | Set-Content $startupPath

# Also do an immediate deploy now
Write-Host "Deploying now..." -ForegroundColor Yellow
$key    = "$HOME\.ssh\hliq_key"
$server = "root@159.69.193.250"
$root   = "C:\Users\jeank\OneDrive\Desktop\hliq"
scp -i $key -r "$root\src"           "${server}:/root/hliq/"
scp -i $key -r "$root\public"        "${server}:/root/hliq/"
scp -i $key    "$root\index.html"    "${server}:/root/hliq/"
scp -i $key    "$root\vite.config.js" "${server}:/root/hliq/"
ssh -i $key $server "pm2 restart hliq"
Write-Host "Deployed. Watcher will auto-start on every login." -ForegroundColor Green
Write-Host "Starting watcher now in background..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Minimized -File `"$scriptPath`"" -WindowStyle Minimized
