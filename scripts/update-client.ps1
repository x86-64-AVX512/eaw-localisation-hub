param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][int]$OwnerProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerStartedAtTicks,
    [switch]$Install
)
. (Join-Path $PSScriptRoot 'ui-language.ps1')


$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-status.ps1')
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
. (Join-Path $PSScriptRoot 'client-update-ui.ps1')
. (Join-Path $PSScriptRoot 'client-update-transfer.ps1')

$projectRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$stateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EaWLocalisationHub'
$updatesRoot = Join-Path $stateRoot 'updates'
$statusPath = Join-Path $stateRoot 'update-status.json'
$releaseApi = 'https://api.github.com/repos/x86-64-AVX512/eaw-localisation-hub/releases?per_page=100'
$releaseDownloadPrefix = 'https://github.com/x86-64-AVX512/eaw-localisation-hub/releases/download/'
$mutex = [System.Threading.Mutex]::new($false, 'Local\EaWHubClientUpdater')
$hasMutex = $false
$workRoot = $null
$clientStopped = $false
$cancelUpdate = [System.Threading.CancellationTokenSource]::new()

function Write-UpdateStatus {
    param([string]$Stage, [string]$Message, [string]$Version = '',
        [Nullable[int]]$ProgressPercent = $null, [long]$BytesReceived = 0, [long]$BytesTotal = 0)
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $record = [pscustomobject]@{
        Stage = $Stage
        Message = $Message
        Version = $Version
        ProgressPercent = $ProgressPercent
        BytesReceived = $BytesReceived
        BytesTotal = $BytesTotal
        InstallRequested = $Install.IsPresent
        UpdatedAt = [DateTime]::UtcNow.ToString('o')
    }
    $temporary = "$statusPath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $statusPath -Force
    Set-ClientUpdateWindowStatus -Status $record
}

function Get-OwnerProcess {
    $candidate = Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue
    if (-not $candidate) { return $null }
    try {
        if ($candidate.StartTime.ToUniversalTime().Ticks -ne $OwnerStartedAtTicks) { return $null }
    } catch { return $null }
    $candidate
}

function Get-ReleaseAsset {
    param($Release, [string]$Name)
    @($Release.assets | Where-Object { $_.name -ceq $Name -and $_.state -eq 'uploaded' }) | Select-Object -First 1
}

function Assert-ReleaseDownloadUrl {
    param([string]$Url, [string]$ExpectedFileName)
    $uri = [Uri]$Url
    if ($uri.Scheme -cne 'https' -or
        -not $Url.StartsWith($releaseDownloadPrefix, [System.StringComparison]::Ordinal) -or
        [Uri]::UnescapeDataString($uri.AbsolutePath).Split('/')[-1] -cne $ExpectedFileName) {
        throw "Unexpected GitHub release asset URL: $Url"
    }
}

function Find-NewClientRelease {
    param([string]$InstalledVersion, [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None)
    $releases = Get-ClientReleaseList -Url $releaseApi -CancellationToken $CancellationToken
    $best = $null
    foreach ($release in $releases) {
        if ($release.draft) { continue }
        $tag = [string]$release.tag_name
        if ($tag -cnotmatch '^(?:v\.?)?(\d+\.\d+\.\d+)(?:F|-beta\.)(\d+)$') { continue }
        $baseVersion = $Matches[1]
        $revision = $Matches[2]
        $canonical = "$baseVersion-beta.$revision"
        if ((Compare-EawHubDisplayVersion -Installed $InstalledVersion -Recommended $canonical) -ge 0) { continue }
        if ($best -and (Compare-EawHubDisplayVersion -Installed $best.Version -Recommended $canonical) -ge 0) { continue }
        # Older releases can have a beta tag with F-style installer assets.
        foreach ($version in @($canonical, "${baseVersion}F$revision")) {
            $installerName = "EaW-Localisation-Hub-Setup-$version.exe"
            $checksumName = "$installerName.sha256"
            $installer = Get-ReleaseAsset -Release $release -Name $installerName
            $checksum = Get-ReleaseAsset -Release $release -Name $checksumName
            if (-not $installer -or -not $checksum) { continue }
            Assert-ReleaseDownloadUrl -Url ([string]$installer.browser_download_url) -ExpectedFileName $installerName
            Assert-ReleaseDownloadUrl -Url ([string]$checksum.browser_download_url) -ExpectedFileName $checksumName
            $best = [pscustomobject]@{
                Version = $version
                Installer = $installer
                Checksum = $checksum
                InstallerName = $installerName
            }
            break
        }
    }
    $best
}

function Stop-CurrentClient {
    $reviewPath = Join-Path $projectRoot 'review\EaWReview.exe'
    Get-Process -Name 'EaWReview' -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ([string]::Equals($_.Path, $reviewPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                if (-not $_.CloseMainWindow()) { Stop-Process -Id $_.Id -ErrorAction Stop }
                elseif (-not $_.WaitForExit(3000)) { Stop-Process -Id $_.Id -ErrorAction Stop }
            }
        } catch { Write-UpdateStatus -Stage 'switching' -Message (Get-EawUiText -Text 'Не удалось закрыть Review: {0}' -Values @($($_.Exception.Message))) }
    }
    $instancePath = Join-Path $stateRoot 'agent-instance.json'
    if (Test-Path -LiteralPath $instancePath -PathType Leaf) {
        try {
            $instance = Get-Content -LiteralPath $instancePath -Raw -Encoding utf8 | ConvertFrom-Json
            $agent = Get-Process -Id ([int]$instance.pid) -ErrorAction Stop
            $expectedNode = Join-Path $projectRoot 'node.exe'
            if ([Math]::Abs(($agent.StartTime.ToUniversalTime() - [DateTime]::Parse([string]$instance.startedAt).ToUniversalTime()).TotalSeconds) -le 10 -and
                [string]::Equals($agent.Path, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $agent.Id -ErrorAction Stop
                [void]$agent.WaitForExit(5000)
            }
        } catch { Write-UpdateStatus -Stage 'switching' -Message (Get-EawUiText -Text 'Не удалось остановить старый Agent: {0}' -Values @($($_.Exception.Message))) }
    }
    $owner = Get-OwnerProcess
    if ($owner) {
        Stop-Process -Id $owner.Id -ErrorAction Stop
        $owner.WaitForExit(5000) | Out-Null
    }
}

function Assert-ClientReleaseInstaller {
    param($Release, [string]$InstallerPath, [string]$ChecksumPath)
    if ((Get-Item -LiteralPath $InstallerPath).Length -ne [int64]$Release.Installer.size -or
        (Get-Item -LiteralPath $ChecksumPath).Length -gt 1024) {
        throw 'Downloaded release asset has an unexpected size.'
    }
    $checksumText = (Get-Content -LiteralPath $ChecksumPath -Raw -Encoding ascii).Trim()
    $checksumMatch = [regex]::Match($checksumText,
        '^([0-9a-fA-F]{64})[ \t]+(EaW-Localisation-Hub-Setup-([0-9]+\.[0-9]+\.[0-9]+(?:F|-beta\.)[0-9]+)\.exe)$')
    if (-not $checksumMatch.Success -or $checksumMatch.Groups[2].Value -cne $Release.InstallerName -or
        $checksumMatch.Groups[3].Value -cne $Release.Version) {
        throw 'Release checksum file does not describe the selected installer.'
    }
    $actualHash = Get-EawFileSha256 -LiteralPath $InstallerPath
    if ($actualHash -ine $checksumMatch.Groups[1].Value) { throw 'Installer SHA-256 mismatch.' }
    if ($Release.Installer.digest -and [string]$Release.Installer.digest -ine "sha256:$actualHash") {
        throw 'Installer disagrees with the GitHub asset digest.'
    }
}

function Invoke-ClientInstaller {
    param([string]$InstallerPath, [string]$InstallRoot)
    if ($InstallRoot.Contains('"') -or $InstallRoot.Contains("`r") -or $InstallRoot.Contains("`n")) {
        throw 'Installation path contains unsupported characters.'
    }
    $arguments = @('/SILENT', '/SP-', '/NORESTART',
        '/RESTARTEXITCODE=3010', '/CLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS',
        ('/DIR="' + $InstallRoot + '"'))
    try {
        $process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -Verb RunAs -PassThru
    } catch {
        for ($exception = $_.Exception; $exception; $exception = $exception.InnerException) {
            if ($exception -is [System.ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 1223) { return $false }
        }
        throw
    }
    try {
        # Keep the handle so Windows PowerShell can read the exit code after Setup exits.
        [void]$process.Handle
        $process.WaitForExit()
        if ($process.ExitCode -in @(2, 5)) { return $false }
        if ($process.ExitCode -ne 0) { throw "Installer finished with exit code $($process.ExitCode)." }
        return $true
    } finally { $process.Dispose() }
}

function Open-ClientSettingsAfterUpdate {
    param([string]$InstallRoot)
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
        (Join-Path $InstallRoot 'scripts\start-agent-ui.ps1') + '" -AfterUpdate'
    Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
        -ArgumentList $arguments -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null
}

try {
    try { $hasMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $hasMutex = $true }
    if (-not $hasMutex) { return }
    if (-not (Get-OwnerProcess)) { return }
    # A source checkout must never replace its own launchers or shortcuts.
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $projectRoot 'review\EaWReview.exe') -PathType Leaf)) { return }
    $installed = Get-EawHubClientStatusMetadata -ProjectRoot $projectRoot
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    if ($Install) {
        Show-ClientUpdateWindow
        Write-UpdateStatus -Stage 'checking' -Message (Get-EawUiText -Text 'Проверяется наличие новой версии на GitHub Releases…') -Version $installed.Version
    }
    $cancelUpdate.Token.ThrowIfCancellationRequested()
    $release = Find-NewClientRelease -InstalledVersion $installed.Version -CancellationToken $cancelUpdate.Token
    $cancelUpdate.Token.ThrowIfCancellationRequested()
    if (-not $release) {
        Write-UpdateStatus -Stage 'current' -Message (Get-EawUiText -Text 'Опубликованной версии новее {0} нет; клиент не менялся.' -Values @($($installed.Version))) -Version $installed.Version
        return
    }

    # Startup, periodic and compatibility checks are read-only. Only an explicit
    # button action may request downloads, stop the client or run an installer.
    if (-not $Install) {
        Write-UpdateStatus -Stage 'available' -Message (Get-EawUiText -Text 'Доступна версия {0}. Нажмите «Обновить клиент…», чтобы скачать и установить её.' -Values @($($release.Version))) -Version $release.Version
        return
    }

    New-Item -ItemType Directory -Path $updatesRoot -Force | Out-Null
    $workRoot = Join-Path $updatesRoot ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
    $installerPath = Join-Path $workRoot $release.InstallerName
    $checksumPath = "$installerPath.sha256"
    Set-ClientUpdateWindowVersion -Version $release.Version
    Write-UpdateStatus -Stage 'downloading' -Message (Get-EawUiText -Text 'Скачивается установщик {0} с GitHub Releases…' -Values @($($release.Version))) -Version $release.Version
    Save-ClientReleaseAsset -Url $release.Installer.browser_download_url -Destination $installerPath `
        -ExpectedBytes ([long]$release.Installer.size) -Version $release.Version -ReportProgress -CancellationToken $cancelUpdate.Token
    Write-UpdateStatus -Stage 'verifying' -Message (Get-EawUiText -Text 'Проверяется целостность установщика (SHA-256)…') -Version $release.Version
    Save-ClientReleaseAsset -Url $release.Checksum.browser_download_url -Destination $checksumPath `
        -ExpectedBytes ([long]$release.Checksum.size) -Version $release.Version -TimeoutSeconds 30 -CancellationToken $cancelUpdate.Token
    Assert-ClientReleaseInstaller -Release $release -InstallerPath $installerPath -ChecksumPath $checksumPath
    Invoke-ClientUpdateUiPulse
    $cancelUpdate.Token.ThrowIfCancellationRequested()
    if (-not (Get-OwnerProcess)) { return }
    Write-UpdateStatus -Stage 'installing' -Message (Get-EawUiText -Text 'Устанавливается клиент {0}; Windows может запросить права администратора…' -Values @($($release.Version))) -Version $release.Version
    $cancelUpdate.Token.ThrowIfCancellationRequested()
    Hide-ClientUpdateWindow
    $clientStopped = $true
    Stop-CurrentClient
    if (-not (Invoke-ClientInstaller -InstallerPath $installerPath -InstallRoot $projectRoot)) {
        Write-UpdateStatus -Stage 'cancelled' -Message (Get-EawUiText -Text 'Обновление отменено.')
        return
    }
    $installedAfter = Get-EawHubClientStatusMetadata -ProjectRoot $projectRoot
    if ($installedAfter.Version -cne $release.Version) {
        throw "Installer did not update the client at $projectRoot."
    }
    Write-UpdateStatus -Stage 'complete' -Message (Get-EawUiText -Text 'Клиент обновлён до {0}. Запустите Agent из окна настроек.' -Values @($($release.Version))) -Version $release.Version -ProgressPercent 100
} catch {
    if ($cancelUpdate.IsCancellationRequested) {
        Write-UpdateStatus -Stage 'cancelled' -Message (Get-EawUiText -Text 'Обновление отменено.')
    } else {
        Write-UpdateStatus -Stage 'error' -Message (Get-EawUiText -Text 'Обновление не удалось: {0}' -Values @($($_.Exception.Message)))
    }
} finally {
    if ($workRoot) {
        $resolvedUpdates = [System.IO.Path]::GetFullPath($updatesRoot).TrimEnd('\') + '\'
        $resolvedWork = [System.IO.Path]::GetFullPath($workRoot)
        if ($resolvedWork.StartsWith($resolvedUpdates, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath $resolvedWork)) {
            Remove-Item -LiteralPath $resolvedWork -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    Close-ClientUpdateWindow
    $cancelUpdate.Dispose()
    if ($clientStopped -and (Test-Path -LiteralPath (Join-Path $projectRoot 'scripts\start-agent-ui.ps1') -PathType Leaf)) {
        Open-ClientSettingsAfterUpdate -InstallRoot $projectRoot
    }
}
