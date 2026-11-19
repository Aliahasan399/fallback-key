param([string]$Title = "Failover", [string]$Message = "")
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Warning
$icon.BalloonTipTitle = $Title
$icon.BalloonTipText = $Message
$icon.Visible = $true
$icon.ShowBalloonTip(6000)
Start-Sleep -Seconds 7
$icon.Dispose()
