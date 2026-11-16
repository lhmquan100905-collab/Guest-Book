<#
  Removes the Guest Book start-at-boot task. Run from a PowerShell window opened
  with "Run as administrator":

      powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1

  Your guest data, backups and logs are not touched.
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'GuestBookServer'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run this from a PowerShell window opened with "Run as administrator".' -ForegroundColor Red; exit 1 }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed the '$TaskName' task. The server will no longer start by itself."
} else {
  Write-Host "No '$TaskName' task found. Nothing to remove."
}
# A server that is already running keeps running until you stop it or restart the computer.
$rule = Get-NetFirewallRule -DisplayName 'Guest Book server' -ErrorAction SilentlyContinue
if ($rule) { Write-Host 'The firewall rule "Guest Book server" was left in place. Remove it in Windows Defender Firewall if you no longer need it.' }
