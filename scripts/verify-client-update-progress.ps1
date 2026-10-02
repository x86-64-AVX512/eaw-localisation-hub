param([string]$DownloadTestUrl = '')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'update-client.ps1') -ProjectRoot $projectRoot -OwnerProcessId 2147483647 -OwnerStartedAtTicks 0
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('EaWHubUpdateProgress-' + [Guid]::NewGuid().ToString('N'))
$tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not [System.IO.Path]::GetFullPath($testRoot).StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Test directory must be inside the temporary directory.'
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
$stateRoot = $testRoot
$statusPath = Join-Path $testRoot 'update-status.json'
$script:realWriteUpdateStatus = ${function:Write-UpdateStatus}
$script:records = [System.Collections.Generic.List[object]]::new()
function Write-UpdateStatus {
    param([string]$Stage, [string]$Message, [string]$Version = '',
        [Nullable[int]]$ProgressPercent = $null, [long]$BytesReceived = 0, [long]$BytesTotal = 0)
    & $script:realWriteUpdateStatus @PSBoundParameters
    $script:records.Add((Get-Content -LiteralPath $statusPath -Raw -Encoding utf8 | ConvertFrom-Json))
}

try {
    # Build real WinForms controls without showing a window during the smoke test.
    Initialize-ClientUpdateWindow -Version '0.8.8F7'
    Write-UpdateStatus -Stage downloading -Message 'Загрузка' -Version '0.8.8F7' `
        -ProgressPercent 37 -BytesReceived 37MB -BytesTotal 100MB
    $view = $script:clientUpdateWindow
    if ($view.Progress.Value -ne 37 -or $view.Progress.Style -ne 'Continuous' -or
        $view.Detail.Text -notmatch '37%' -or $view.Detail.Text -notmatch 'МБ') { throw 'Download progress UI did not reflect the status.' }
    Write-UpdateStatus -Stage installing -Message 'Установка'
    if ($view.Progress.Style -ne 'Marquee' -or $view.Terminal) { throw 'Installation must use a waiting indicator, not a fake percentage.' }
    Write-UpdateStatus -Stage restarting -Message 'Запуск Agent'
    if ($view.Detail.Text -notmatch 'Agent') { throw 'Restart stage is not visible.' }
    Write-UpdateStatus -Stage complete -Message 'Готово' -ProgressPercent 100
    if (-not $view.Terminal -or $view.Failed -or $view.Progress.Value -ne 100) { throw 'Success UI state is incorrect.' }
    Write-UpdateStatus -Stage error -Message 'Ошибка: вход в Agent не выполнен'
    if (-not $view.Failed -or $view.Message.Text -notmatch 'Ошибка') { throw 'Failure was hidden or lost its Unicode text.' }
    $view.Form.Dispose()
    $script:clientUpdateWindow = $null

    # Verify identity, version, start time and discovery, not just a recycled PID.
    $now = [DateTime]::UtcNow
    $script:mockAgent = [pscustomobject]@{ Id = 1234; StartTime = $now; HasExited = $false; Path = (Join-Path $projectRoot 'node.exe') }
    function Get-Process { param($Id, $ErrorAction); $script:mockAgent }
    $instance = [pscustomobject]@{ schema = 1; pid = 1234; version = '0.8.8F7'; startedAt = $now.ToString('o') }
    function Save-TestInstance {
        [IO.File]::WriteAllText((Join-Path $stateRoot 'agent-instance.json'), ($instance | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText((Join-Path $stateRoot 'review-session.json'), '{"pid":1234}')
    Save-TestInstance
    if (-not (Get-UpdatedAgentProcess -InstallRoot $projectRoot -Version '0.8.8F7' -NotBefore $now)) { throw 'A verified new Agent was rejected.' }
    $instance.version = '0.8.8F6'; Save-TestInstance
    if (Get-UpdatedAgentProcess -InstallRoot $projectRoot -Version '0.8.8F7' -NotBefore $now) { throw 'An old Agent was accepted.' }
    $instance.version = '0.8.8F7'; Save-TestInstance
    $script:mockAgent.Path = 'C:\OtherClient\node.exe'
    if (Get-UpdatedAgentProcess -InstallRoot $projectRoot -Version '0.8.8F7' -NotBefore $now) { throw 'An unrelated process was accepted.' }
    $script:mockAgent.Path = Join-Path $projectRoot 'node.exe'
    $script:mockAgent.StartTime = $now.AddMinutes(-1)
    if (Get-UpdatedAgentProcess -InstallRoot $projectRoot -Version '0.8.8F7' -NotBefore $now) { throw 'A stale/recycled PID was accepted.' }
    $script:mockAgent.StartTime = $now
    [IO.File]::WriteAllText((Join-Path $stateRoot 'review-session.json'), '{"pid":5678}')
    if (Get-UpdatedAgentProcess -InstallRoot $projectRoot -Version '0.8.8F7' -NotBefore $now) { throw 'Stale Review discovery was accepted.' }
    Remove-Item Function:Get-Process

    $script:agentInvocation = $null
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle)
        $script:agentInvocation = [pscustomobject]@{ FilePath = $FilePath; Arguments = $ArgumentList; Root = $WorkingDirectory; Style = $WindowStyle }
    }
    Start-ClientAfterUpdate -InstallRoot 'C:\Program Files\EaW Localisation Hub'
    if ($script:agentInvocation.Arguments -notmatch '"C:\\Program Files\\EaW Localisation Hub\\scripts\\start-agent-ui.ps1" -StartMinimized$' -or
        $script:agentInvocation.Root -cne 'C:\Program Files\EaW Localisation Hub' -or
        $script:agentInvocation.Style -cne 'Hidden') { throw 'Agent UI restart lost auto-start, path quoting or hidden console arguments.' }
    Remove-Item Function:Start-Process

    $script:launchCount = 0
    $script:reviewCount = 0
    $script:ready = $true
    function Start-ClientAfterUpdate { param($InstallRoot); $script:launchCount++ }
    function Get-UpdatedAgentProcess { param($InstallRoot, $Version, $NotBefore); if ($script:ready) { $script:mockAgent } }
    function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle); $script:reviewCount++ }
    Restart-UpdatedClient -InstallRoot $projectRoot -Version '0.8.8F7' -ReopenReview $false | Out-Null
    if ($script:launchCount -ne 1 -or $script:reviewCount -ne 0) { throw 'Agent restart incorrectly depends on Review being open.' }
    Restart-UpdatedClient -InstallRoot $projectRoot -Version '0.8.8F7' -ReopenReview $true | Out-Null
    if ($script:launchCount -ne 2 -or $script:reviewCount -ne 1) { throw 'Review was not reopened after Agent readiness.' }
    $script:ready = $false
    $rejected = $false
    try { Restart-UpdatedClient -InstallRoot $projectRoot -Version '0.8.8F7' -ReopenReview $true -TimeoutSeconds 0 | Out-Null }
    catch { $rejected = $_.Exception.Message -match 'Agent' }
    if (-not $rejected -or $script:reviewCount -ne 1 -or $script:records[-1].Stage -eq 'complete') { throw 'Failed restart was reported as success or opened Review.' }
    Remove-Item Function:Start-Process

    if ($DownloadTestUrl) {
        $uri = [Uri]$DownloadTestUrl
        if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') { throw 'Download fixture must be loopback HTTP.' }
        $script:records.Clear()
        $downloadPath = Join-Path $testRoot 'fixture.bin'
        Save-ClientReleaseAsset -Url "$DownloadTestUrl/asset" -Destination $downloadPath -ExpectedBytes 1MB -Version '0.8.8F7' -ReportProgress
        $intermediate = @($script:records | Where-Object { $_.ProgressPercent -gt 0 -and $_.ProgressPercent -lt 100 })
        if ($intermediate.Count -lt 2 -or $script:records[-1].ProgressPercent -ne 100 -or
            $script:records[-1].BytesReceived -ne 1MB -or (Get-Item $downloadPath).Length -ne 1MB) { throw 'Streaming download did not produce intermediate and final progress.' }
        $bytes = [IO.File]::ReadAllBytes($downloadPath)
        if (@($bytes | Where-Object { $_ -ne 65 }).Count) { throw 'Streaming download corrupted the asset.' }
        foreach ($case in @(
            @{ Route = 'short'; Size = 1MB; Timeout = 10 },
            @{ Route = 'asset'; Size = 1; Timeout = 10 },
            @{ Route = 'error'; Size = 1; Timeout = 10 },
            @{ Route = 'stall'; Size = 1; Timeout = 1 }
        )) {
            $rejected = $false
            try { Save-ClientReleaseAsset -Url "$DownloadTestUrl/$($case.Route)" -Destination (Join-Path $testRoot ($case.Route + '.bin')) -ExpectedBytes $case.Size -TimeoutSeconds $case.Timeout }
            catch { $rejected = $true }
            if (-not $rejected) { throw "Invalid/failed download '$($case.Route)' was accepted." }
        }
        Write-Output '[client-update-progress] real loopback streaming, intermediate progress, size checks, HTTP errors and timeout passed'
    }
    Write-Output '[client-update-progress] WinForms status, Unicode, verified restart, stale identity and restart failure passed'
} finally {
    if ($script:clientUpdateWindow) { $script:clientUpdateWindow.Form.Dispose(); $script:clientUpdateWindow = $null }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
