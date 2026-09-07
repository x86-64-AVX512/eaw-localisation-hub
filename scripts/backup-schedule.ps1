function Get-EawBackupTriggerTime {
    param([TimeSpan]$At = '03:00:00', [DateTime]$Today = [DateTime]::Today)
    if ($At -lt [TimeSpan]::Zero -or $At -ge [TimeSpan]::FromDays(1)) {
        throw 'Backup time must be between 00:00:00 and 23:59:59.'
    }
    return $Today.Date.Add($At)
}
