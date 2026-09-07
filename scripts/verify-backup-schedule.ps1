$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-schedule.ps1')
$day = [DateTime]::new(2026, 9, 7)
$time = Get-EawBackupTriggerTime -Today $day
if ($time -isnot [DateTime] -or $time -ne $day.AddHours(3)) { throw 'Invalid default backup time.' }
$trigger = New-ScheduledTaskTrigger -Daily -At $time
if ([DateTime]::Parse($trigger.StartBoundary) -ne $time -or $trigger.DaysInterval -ne 1) {
    throw 'Daily backup trigger does not contain the selected time.'
}
foreach ($invalid in @('-01:00:00', '1.00:00:00')) {
    $rejected = $false
    try { Get-EawBackupTriggerTime -At $invalid | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid backup time was accepted.' }
}
Write-Output '[backup-schedule-smoke] daily 03:00 trigger verified; no task registered'
