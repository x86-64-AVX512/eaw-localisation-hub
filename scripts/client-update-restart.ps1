function Get-UpdatedAgentProcess {
    param([string]$InstallRoot, [string]$Version, [DateTime]$NotBefore)
    try {
        $instance = Get-Content -LiteralPath (Join-Path $stateRoot 'agent-instance.json') -Raw -Encoding utf8 | ConvertFrom-Json
        if ([int]$instance.schema -ne 1 -or [int]$instance.pid -le 0 -or [string]$instance.version -cne $Version) { return $null }
        $candidate = Get-Process -Id ([int]$instance.pid) -ErrorAction Stop
        $started = $candidate.StartTime.ToUniversalTime()
        if ($candidate.HasExited -or $started -lt $NotBefore.ToUniversalTime().AddSeconds(-1) -or
            [Math]::Abs(($started - [DateTime]::Parse([string]$instance.startedAt).ToUniversalTime()).TotalSeconds) -gt 10 -or
            -not [string]::Equals($candidate.Path, (Join-Path $InstallRoot 'node.exe'), [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
        $session = Get-Content -LiteralPath (Join-Path $stateRoot 'review-session.json') -Raw -Encoding utf8 | ConvertFrom-Json
        if ([int]$session.pid -ne $candidate.Id) { return $null }
        return $candidate
    } catch { return $null }
}

function Start-ClientAfterUpdate {
    param([string]$InstallRoot)
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
        (Join-Path $InstallRoot 'scripts\start-agent-ui.ps1') + '" -StartMinimized'
    Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
        -ArgumentList $arguments -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null
}

function Restart-UpdatedClient {
    param([string]$InstallRoot, [string]$Version, [bool]$ReopenReview,
        [int]$TimeoutSeconds = 45)
    Write-UpdateStatus -Stage 'restarting' -Message "Клиент $Version установлен. Запускается новый Agent…" -Version $Version
    $notBefore = [DateTime]::UtcNow
    Start-ClientAfterUpdate -InstallRoot $InstallRoot
    $script:clientRestartLaunched = $true
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $agent = $null
    do {
        Invoke-ClientUpdateUiPulse
        $agent = Get-UpdatedAgentProcess -InstallRoot $InstallRoot -Version $Version -NotBefore $notBefore
        if ($agent) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $agent) { throw "Обновление установлено, но новый Agent не запустился за $TimeoutSeconds секунд. Откройте окно Agent и проверьте вход и журнал." }
    if ($ReopenReview) {
        $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
            (Join-Path $InstallRoot 'scripts\start-hub.ps1') + '"'
        Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
            -ArgumentList $arguments -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null
    }
    return $agent
}
