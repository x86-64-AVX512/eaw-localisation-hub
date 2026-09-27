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
    $releases = @(Invoke-RestMethod -Uri $releaseApi -Headers $headers -TimeoutSec 20)
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
        $archiveName = "EaW-Hub-Client-$version.zip"
        $checksumName = "$archiveName.sha256"
        $archive = Get-ReleaseAsset -Release $release -Name $archiveName
        $checksum = Get-ReleaseAsset -Release $release -Name $checksumName
        if (-not $archive -or -not $checksum) { continue }
        Assert-ReleaseDownloadUrl -Url ([string]$archive.browser_download_url) -ExpectedFileName $archiveName
        Assert-ReleaseDownloadUrl -Url ([string]$checksum.browser_download_url) -ExpectedFileName $checksumName
        $best = [pscustomobject]@{
            Version = $version
            Archive = $archive
            Checksum = $checksum
            ArchiveName = $archiveName
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

function Move-AutostartToNewClient {
    param([string]$NewRoot)
    $startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'EaW Localisation Hub Agent.lnk'
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $legacyRun = [string](Get-ItemProperty -Path $runKey -Name 'EaWLocalisationHubAgent' -ErrorAction SilentlyContinue).EaWLocalisationHubAgent
    $oldLauncher = Join-Path $projectRoot 'Launch EaW Hub Agent.cmd'
    $migrateLegacyRun = $legacyRun.Trim('"') -ieq $oldLauncher
    if (-not (Test-Path -LiteralPath $startupPath) -and -not $migrateLegacyRun) { return }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupPath)
    $shortcut.TargetPath = (Get-Command powershell.exe -ErrorAction Stop).Source
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
        (Join-Path $NewRoot 'scripts\start-agent-ui.ps1') + '" -StartMinimized'
    $shortcut.WorkingDirectory = $NewRoot
    $shortcut.IconLocation = Join-Path $NewRoot 'review\EaWReview.exe'
    $shortcut.Save()
    if ($migrateLegacyRun) {
        Remove-ItemProperty -Path $runKey -Name 'EaWLocalisationHubAgent' -ErrorAction Stop
    }
}

function Expand-CheckedClientArchive {
    param([string]$ArchivePath, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destinationRoot = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $totalBytes = [int64]0
        foreach ($entry in $archive.Entries) {
            if ([System.IO.Path]::IsPathRooted($entry.FullName)) { throw 'Client archive contains an absolute path.' }
            $entryPath = [System.IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
            if (-not $entryPath.StartsWith($destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'Client archive contains a path outside its extraction directory.'
            }
            $totalBytes += $entry.Length
            if ($totalBytes -gt 1GB) { throw 'Client archive is unexpectedly large after extraction.' }
        }
    } finally { $archive.Dispose() }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Destination -Force
}

function Assert-ClientReleaseArchive {
    param($Release, [string]$ArchivePath, [string]$ChecksumPath)
    if ((Get-Item -LiteralPath $ArchivePath).Length -ne [int64]$Release.Archive.size -or
        (Get-Item -LiteralPath $ChecksumPath).Length -gt 1024) {
        throw 'Downloaded release asset has an unexpected size.'
    }
    $checksumText = (Get-Content -LiteralPath $ChecksumPath -Raw -Encoding ascii).Trim()
    $checksumMatch = [regex]::Match($checksumText, '^([0-9a-fA-F]{64})[ \t]+(EaW-Hub-Client-[0-9]+\.[0-9]+\.[0-9]+F[0-9]+\.zip)$')
    if (-not $checksumMatch.Success -or $checksumMatch.Groups[2].Value -cne $Release.ArchiveName) {
        throw 'Release checksum file does not describe the selected client archive.'
    }
    $actualHash = Get-EawFileSha256 -LiteralPath $ArchivePath
    if ($actualHash -ine $checksumMatch.Groups[1].Value) { throw 'Client archive SHA-256 mismatch.' }
    if ($Release.Archive.digest -and [string]$Release.Archive.digest -ine "sha256:$actualHash") {
        throw 'Client archive disagrees with the GitHub asset digest.'
    }
}

function Assert-ClientPackage {
    param([string]$PackageRoot, [string]$Version)
    $packageVersion = (Get-Content -LiteralPath (Join-Path $PackageRoot 'VERSION') -Raw -Encoding utf8).Trim()
    if ($packageVersion -cne $Version) { throw 'Client package version does not match the GitHub release tag.' }
    foreach ($required in @('node.exe', 'scripts\install-client.ps1', 'scripts\start-agent-ui.ps1', 'scripts\update-client.ps1', 'scripts\hash-utils.ps1', 'review\EaWReview.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $required) -PathType Leaf)) {
            throw "Client archive is missing $required"
        }
    }
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
    $archivePath = Join-Path $workRoot $release.ArchiveName
    $checksumPath = "$archivePath.sha256"
    Write-UpdateStatus -Stage 'downloading' -Message "Скачивается клиент $($release.Version) с GitHub Releases…" -Version $release.Version
    Invoke-WebRequest -Uri $release.Archive.browser_download_url -UseBasicParsing -TimeoutSec 600 -OutFile $archivePath
    Invoke-WebRequest -Uri $release.Checksum.browser_download_url -UseBasicParsing -TimeoutSec 30 -OutFile $checksumPath
    Assert-ClientReleaseArchive -Release $release -ArchivePath $archivePath -ChecksumPath $checksumPath

    $packageRoot = Join-Path $workRoot 'package'
    Expand-CheckedClientArchive -ArchivePath $archivePath -Destination $packageRoot
    Assert-ClientPackage -PackageRoot $packageRoot -Version $release.Version
    if (-not (Get-OwnerProcess)) { return }
    Write-UpdateStatus -Stage 'installing' -Message "Устанавливается клиент $($release.Version)…" -Version $release.Version
    & (Join-Path $packageRoot 'scripts\install-client.ps1') -DoNotLaunch | Out-Null
    $newRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Programs\EaW Localisation Hub\Client-$($release.Version)"
    if (-not (Test-Path -LiteralPath (Join-Path $newRoot 'installation.json') -PathType Leaf)) {
        throw 'The new client installation did not complete.'
    }
    Move-AutostartToNewClient -NewRoot $newRoot
    Write-UpdateStatus -Stage 'switching' -Message "Обновление $($release.Version) установлено; перезапуск клиента…" -Version $release.Version
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
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
        (Join-Path $newRoot 'scripts\start-agent-ui.ps1') + '" -StartMinimized'
    Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
        -ArgumentList $arguments -WorkingDirectory $newRoot -WindowStyle Hidden
    if ($reviewWasOpen) {
        $sessionPath = Join-Path $stateRoot 'review-session.json'
        $newNodePath = Join-Path $newRoot 'node.exe'
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
                (Join-Path $newRoot 'scripts\start-hub.ps1') + '"'
            Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
                -ArgumentList $reviewArguments -WorkingDirectory $newRoot -WindowStyle Hidden
        } else {
            Write-UpdateStatus -Stage 'complete' -Message "Клиент обновлён до $($release.Version), но Review не удалось открыть автоматически." -Version $release.Version
            return
        }
    }
    Write-UpdateStatus -Stage 'complete' -Message "Клиент обновлён до $($release.Version)." -Version $release.Version
} catch {
    Write-UpdateStatus -Stage 'error' -Message "Автообновление не удалось: $($_.Exception.Message)"
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
