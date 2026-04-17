$key     = "$HOME\.ssh\hliq_key"
$server  = "root@159.69.193.250"
$rootPath = "C:\Users\jeank\OneDrive\Desktop\hliq"

Write-Host "Watching for changes. Save any file to auto-deploy." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop."

$lastDeploy = [DateTime]::MinValue

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $rootPath
$watcher.Filter = "*.*"
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true

while ($true) {
    $change = $watcher.WaitForChanged("All", 1000)
    if (-not $change.TimedOut) {
        $changed = $change.Name
        # Ignore node_modules, .git, logs, deploy/watch scripts themselves
        if ($changed -match '(node_modules|\.git|logs|watch\.ps1|deploy\.ps1)') { continue }

        $now = [DateTime]::Now
        if (($now - $lastDeploy).TotalSeconds -gt 2) {
            $lastDeploy = $now
            Write-Host "Change detected in $changed - deploying..." -ForegroundColor Yellow
            scp -i $key -r "${rootPath}\src"          "${server}:/root/hliq/"
            scp -i $key -r "${rootPath}\public"       "${server}:/root/hliq/"
            scp -i $key    "${rootPath}\index.html"   "${server}:/root/hliq/"
            scp -i $key    "${rootPath}\vite.config.js" "${server}:/root/hliq/"
            ssh -i $key $server "pm2 restart hliq"
            Write-Host "Done." -ForegroundColor Green
        }
    }
}
