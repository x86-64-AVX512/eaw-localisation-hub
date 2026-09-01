param(
    [Parameter(Mandatory = $true)][string]$Server,
    [TimeSpan]$At = '03:00:00',
    [string]$Destination = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'EaW Hub Backups'),
    [ValidateRange(1, 365)][int]$Keep = 14,
    [string]$TaskName = 'EaW Localisation Hub Backup'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-store.ps1')
$credentialTarget = Get-EawHubCredentialTarget -Server $Server -Kind 'BackupToken'
if (-not (Get-EawHubCredential -Target $credentialTarget)) {
    throw 'Backup token is not stored. Enable the schedule from the administrator window first.'
}
if (-not (Get-EawHubCredential -Target 'EaWLocalisationHub.BackupPassphrase')) {
    throw 'Backup passphrase is not stored. Set it in the administrator window first.'
}
foreach ($value in @($PSCommandPath, $Server, $Destination)) {
    if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) {
        throw 'A scheduled-task argument contains an unsupported quote or line break.'
    }
}
$backupScript = Join-Path $PSScriptRoot 'backup-server.ps1'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $backupScript +
    '" -Server "' + $Server + '" -Destination "' + $Destination + '" -Keep ' + $Keep
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe -ErrorAction Stop).Source -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Encrypted external backup of EaW Localisation Hub server state.' -Force | Out-Null
Write-Output "Scheduled task '$TaskName' runs daily at $At and catches up after the next user logon."
