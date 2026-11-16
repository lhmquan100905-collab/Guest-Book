<#
  Makes the Guest Book server start by itself when this Windows computer starts,
  and restart if it ever stops. Uses Windows Task Scheduler, so nothing extra
  needs to be installed.

  Run ONCE, from a PowerShell window opened with "Run as administrator", inside
  the project folder:

      powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

  Options:
      -Port 3000       The port the server listens on (default 3000).
      -OpenFirewall    Also allow tablets on the private Wi-Fi to reach that port.
      -NoSleep         Stop this computer sleeping while plugged in.

  Undo it with:  scripts\uninstall-autostart.ps1
#>
param(
  [int]$Port = 3000,
  [switch]$OpenFirewall,
  [switch]$NoSleep
)
$ErrorActionPreference = 'Stop'
$TaskName = 'GuestBookServer'

# Must be run as administrator (the task runs before anyone signs in).
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run this from a PowerShell window opened with "Run as administrator".' -ForegroundColor Red; exit 1 }

$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path (Join-Path $project 'server.js'))) { Write-Host "server.js not found in $project" -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $project 'node_modules'))) { Write-Host 'Run "npm install" in the project folder first.' -ForegroundColor Red; exit 1 }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Host 'Node.js was not found. Install Node.js 22 or later from https://nodejs.org first.' -ForegroundColor Red; exit 1 }
$node = $nodeCmd.Source

# The task runs as the SYSTEM account, which cannot see programs installed only for one user.
if ($node -like "$env:USERPROFILE*") {
  Write-Host "Node.js is installed inside your user folder:`n  $node" -ForegroundColor Yellow
  Write-Host 'The startup task runs as SYSTEM and may not be able to use it. Install Node.js for all users' -ForegroundColor Yellow
  Write-Host '(the normal installer from nodejs.org does this), then run this script again.' -ForegroundColor Yellow
  exit 1
}

$logs = Join-Path $project 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs 'server.log'

# cmd.exe is used so the server's output can be saved to a log file and the port can be
# set for this process only (nothing else on the computer is affected).
$arg = '/c "set PORT={2}&& "{0}" server.js >> "{1}" 2>&1"' -f $node, $log, $Port
$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $project
$trigger  = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Starts the Guest Book server at boot and restarts it if it stops.' | Out-Null

if ($OpenFirewall) {
  $rule = 'Guest Book server'
  if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
  }
  Write-Host "Firewall: allowed inbound TCP $Port on private networks."
}

if ($NoSleep) {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null
  Write-Host 'Power: this computer will not sleep or hibernate while plugged in.'
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host ''
Write-Host "Done. Task '$TaskName' is installed (state: $state)." -ForegroundColor Green
Write-Host "  Server folder : $project"
Write-Host "  Log file      : $log"
Write-Host "  Address       : http://localhost:$Port  (or https:// if you installed certificates)"
Write-Host ''
Write-Host 'Check it: open the address above. Then restart the computer once and check it comes back by itself.'
Write-Host 'If the server was already running in a window, close that window so the two do not clash on the port.'
