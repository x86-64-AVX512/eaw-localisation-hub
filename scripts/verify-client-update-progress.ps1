param([string]$DownloadTestUrl = '')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'update-client.ps1') -ProjectRoot $projectRoot -OwnerProcessId 2147483647 -OwnerStartedAtTicks 0
# Assertions below use Russian labels; never depend on the user's saved UI
# preference or change it while verifying the updater.
function Get-EawUiLanguageSettings { [pscustomobject]@{ language = 'ru'; preference = 'ru' } }
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

$cancelUpdate = [System.Threading.CancellationTokenSource]::new()
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
    if ($view.Form.CancelButton -ne $view.Close -or -not $view.Close.Enabled -or $view.Close.Text -ne 'Отмена') {
        throw 'The update window must offer cancellation before installation.'
    }
    # Keep it hidden and create the handle so Form.Close runs FormClosing.
    [void]$view.Form.Handle
    $view.Form.Close()
    if (-not $cancelUpdate.IsCancellationRequested -or $view.Form.IsDisposed) {
        throw 'Closing the progress window did not request cancellation.'
    }
    Write-UpdateStatus -Stage cancelled -Message 'Обновление отменено.'
    if (-not $view.Terminal -or $view.Failed -or $view.Progress.Value -ne 0) { throw 'Cancellation UI state is incorrect.' }
    Write-UpdateStatus -Stage complete -Message 'Готово' -ProgressPercent 100
    if (-not $view.Terminal -or $view.Failed -or $view.Progress.Value -ne 100) { throw 'Success UI state is incorrect.' }
    Close-ClientUpdateWindow

    $script:agentInvocation = $null
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle)
        $script:agentInvocation = [pscustomobject]@{ FilePath = $FilePath; Arguments = $ArgumentList; Root = $WorkingDirectory; Style = $WindowStyle }
    }
    Open-ClientSettingsAfterUpdate -InstallRoot 'C:\Program Files\EaW Localisation Hub'
    if (-not $script:agentInvocation.Arguments.EndsWith('" -AfterUpdate') -or
        $script:agentInvocation.Arguments -match 'StartMinimized|start-hub.ps1' -or
        $script:agentInvocation.Root -cne 'C:\Program Files\EaW Localisation Hub' -or
        $script:agentInvocation.Style -cne 'Hidden') { throw 'Update must open settings without requesting Agent or Review.' }
    Remove-Item Function:Start-Process

    if ($DownloadTestUrl) {
        $uri = [Uri]$DownloadTestUrl
        if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') { throw 'Download fixture must be loopback HTTP.' }
        $releases = Get-ClientReleaseList -Url "$DownloadTestUrl/releases" -CancellationToken ([System.Threading.CancellationToken]::None)
        if ($releases.Count -ne 2 -or $releases[0].tag_name -cne 'v0.8.9F3') {
            throw 'The release check did not return the GitHub-style JSON array.'
        }
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
        $caller = [System.Threading.CancellationTokenSource]::new()
        try {
            $caller.CancelAfter(500)
            $cancelled = $false
            try {
                Save-ClientReleaseAsset -Url "$DownloadTestUrl/stall" -Destination (Join-Path $testRoot 'cancelled.bin') `
                    -ExpectedBytes 1 -TimeoutSeconds 10 -CancellationToken $caller.Token
            } catch {
                $cancelled = $caller.IsCancellationRequested -and $_.Exception.InnerException -is [OperationCanceledException]
            }
            if (-not $cancelled) { throw 'Caller cancellation did not stop a stalled transfer.' }
        } finally { $caller.Dispose() }
        Write-Output '[client-update-progress] real loopback streaming, intermediate progress, validation and cancellation passed'
    }
    Write-Output '[client-update-progress] WinForms status, cancellation and settings-only launch passed'
} finally {
    $cancelUpdate.Dispose()
    if ($script:clientUpdateWindow) { $script:clientUpdateWindow.Form.Dispose(); $script:clientUpdateWindow = $null }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
