# Windows: start the failover proxy in the background.
$dir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$existing = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($existing) { Write-Output "Proxy already listening on 8787"; exit }
Start-Process -FilePath $node -ArgumentList "`"$dir\src\index.mjs`"" -WorkingDirectory $dir -WindowStyle Hidden
Write-Output "Started. Config: $dir\failover-proxy.json (copy from config.example.json first)"
