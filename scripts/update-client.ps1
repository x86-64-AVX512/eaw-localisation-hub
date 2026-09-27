param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][int]$OwnerProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerStartedAtTicks
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-status.ps1')
. (Join-Path $PSScriptRoot 'hash-utils.ps1')

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

function Write-UpdateStatus {
    param([string]$Stage, [string]$Message, [string]$Version = '')
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $record = [pscustomobject]@{
        Stage = $Stage
        Message = $Message
        Version = $Version
        UpdatedAt = [DateTime]::UtcNow.ToString('o')
    }
    $temporary = "$statusPath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $statusPath -Force
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
    param([string]$InstalledVersion)
    $headers = @{
        'Accept' = 'application/vnd.github+json'
        'User-Agent' = 'EaWLocalisationHub-Updater'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    # Windows PowerShell 5.1 can return a JSON array as one array-valued
    # object. Wrapping the command in @() would nest it and hide every release.
    $releases = Invoke-RestMethod -Uri $releaseApi -Headers $headers -TimeoutSec 20
    $best = $null
    foreach ($release in $releases) {
        if ($release.draft) { continue }
        $tag = [string]$release.tag_name
        if ($tag -match '^(?:v\.)?(\d+\.\d+\.\d+F\d+)$') {
            $version = $Matches[1]
        } elseif ($tag -match '^v(\d+\.\d+\.\d+)-beta\.(\d+)$') {
            $version = "$($Matches[1])F$($Matches[2])"
        } else { continue }
        if ((Compare-EawHubDisplayVersion -Installed $InstalledVersion -Recommended $version) -ge 0) { continue }
        if ($best -and (Compare-EawHubDisplayVersion -Installed $best.Version -Recommended $version) -ge 0) { continue }
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
    }
    $best
}

function Stop-CurrentClient {
    $instancePath = Join-Path $stateRoot 'agent-instance.json'
    if (Test-Path -LiteralPath $instancePath -PathType Leaf) {
        try {
            $instance = Get-Content -LiteralPath $instancePath -Raw -Encoding utf8 | ConvertFrom-Json
            $agent = Get-Process -Id ([int]$instance.pid) -ErrorAction Stop
            $expectedNode = Join-Path $projectRoot 'node.exe'
            if ([Math]::Abs(($agent.StartTime.ToUniversalTime() - [DateTime]::Parse([string]$instance.startedAt).ToUniversalTime()).TotalSeconds) -le 10 -and
                [string]::Equals($agent.Path, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $agent.Id -ErrorAction Stop
            }
        } catch { Write-UpdateStatus -Stage 'switching' -Message "Не удалось остановить старый Agent: $($_.Exception.Message)" }
    }
    $reviewPath = Join-Path $projectRoot 'review\EaWReview.exe'
    Get-Process -Name 'EaWReview' -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ([string]::Equals($_.Path, $reviewPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                if (-not $_.CloseMainWindow()) { Stop-Process -Id $_.Id -ErrorAction Stop }
                elseif (-not $_.WaitForExit(3000)) { Stop-Process -Id $_.Id -ErrorAction Stop }
            }
        } catch { Write-UpdateStatus -Stage 'switching' -Message "Не удалось закрыть Review: $($_.Exception.Message)" }
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
        '^([0-9a-fA-F]{64})[ \t]+(EaW-Localisation-Hub-Setup-([0-9]+\.[0-9]+\.[0-9]+F[0-9]+)\.exe)$')
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
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART',
        '/RESTARTEXITCODE=3010', '/CLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS',
        ('/DIR="' + $InstallRoot + '"'))
    $process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer finished with exit code $($process.ExitCode)." }
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
    $release = Find-NewClientRelease -InstalledVersion $installed.Version
    if (-not $release) {
        Write-UpdateStatus -Stage 'current' -Message "Опубликованной версии новее $($installed.Version) нет; клиент не менялся." -Version $installed.Version
        return
    }

    New-Item -ItemType Directory -Path $updatesRoot -Force | Out-Null
    $workRoot = Join-Path $updatesRoot ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
    $installerPath = Join-Path $workRoot $release.InstallerName
    $checksumPath = "$installerPath.sha256"
    Write-UpdateStatus -Stage 'downloading' -Message "Скачивается установщик $($release.Version) с GitHub Releases…" -Version $release.Version
    Invoke-WebRequest -Uri $release.Installer.browser_download_url -UseBasicParsing -TimeoutSec 600 -OutFile $installerPath
    Invoke-WebRequest -Uri $release.Checksum.browser_download_url -UseBasicParsing -TimeoutSec 30 -OutFile $checksumPath
    Assert-ClientReleaseInstaller -Release $release -InstallerPath $installerPath -ChecksumPath $checksumPath
    if (-not (Get-OwnerProcess)) { return }
    Write-UpdateStatus -Stage 'installing' -Message "Устанавливается клиент $($release.Version); Windows может запросить права администратора…" -Version $release.Version
    $oldReviewPath = Join-Path $projectRoot 'review\EaWReview.exe'
    $reviewWasOpen = $false
    foreach ($candidate in @(Get-Process -Name 'EaWReview' -ErrorAction SilentlyContinue)) {
        try {
            if ([string]::Equals($candidate.Path, $oldReviewPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                $reviewWasOpen = $true
            }
        } catch {}
    }
    Stop-CurrentClient
    $clientStopped = $true
    Invoke-ClientInstaller -InstallerPath $installerPath -InstallRoot $projectRoot
    $installedAfter = Get-EawHubClientStatusMetadata -ProjectRoot $projectRoot
    if ($installedAfter.Version -cne $release.Version) {
        throw "Installer did not update the client at $projectRoot."
    }
    Write-UpdateStatus -Stage 'switching' -Message "Обновление $($release.Version) установлено; перезапуск клиента…" -Version $release.Version
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
        (Join-Path $projectRoot 'scripts\start-agent-ui.ps1') + '" -StartMinimized'
    Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
        -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden
    $clientStopped = $false
    if ($reviewWasOpen) {
        $sessionPath = Join-Path $stateRoot 'review-session.json'
        $newNodePath = Join-Path $projectRoot 'node.exe'
        $reviewReady = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Milliseconds 500
            try {
                $session = Get-Content -LiteralPath $sessionPath -Raw -Encoding utf8 | ConvertFrom-Json
                $newAgent = Get-Process -Id ([int]$session.pid) -ErrorAction Stop
                if ([string]::Equals($newAgent.Path, $newNodePath, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $reviewReady = $true
                    break
                }
            } catch {}
        }
        if ($reviewReady) {
            $reviewArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
                (Join-Path $projectRoot 'scripts\start-hub.ps1') + '"'
            Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
                -ArgumentList $reviewArguments -WorkingDirectory $projectRoot -WindowStyle Hidden
        } else {
            Write-UpdateStatus -Stage 'complete' -Message "Клиент обновлён до $($release.Version), но Review не удалось открыть автоматически." -Version $release.Version
            return
        }
    }
    Write-UpdateStatus -Stage 'complete' -Message "Клиент обновлён до $($release.Version)." -Version $release.Version
} catch {
    Write-UpdateStatus -Stage 'error' -Message "Автообновление не удалось: $($_.Exception.Message)"
    if ($clientStopped -and (Test-Path -LiteralPath (Join-Path $projectRoot 'scripts\start-agent-ui.ps1') -PathType Leaf)) {
        try {
            $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
                (Join-Path $projectRoot 'scripts\start-agent-ui.ps1') + '" -StartMinimized'
            Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
                -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden
        } catch {}
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
}
