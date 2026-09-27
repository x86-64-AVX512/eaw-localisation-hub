param([switch]$Integration, [switch]$PublishedRelease, [switch]$ReinstallCurrent)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'update-client.ps1') -ProjectRoot $projectRoot -OwnerProcessId 2147483647 -OwnerStartedAtTicks 0

function New-TestRelease {
    param([string]$Version, [bool]$Draft = $false, [bool]$Complete = $true)
    $tag = [regex]::Replace($Version, '^(\d+\.\d+\.\d+)F(\d+)$', 'v$1-beta.$2')
    $installerName = "EaW-Localisation-Hub-Setup-$Version.exe"
    $assets = @([pscustomobject]@{
        name = $installerName
        state = 'uploaded'
        browser_download_url = "https://github.com/x86-64-AVX512/eaw-localisation-hub/releases/download/$tag/$installerName"
    })
    if ($Complete) {
        $checksumName = "$installerName.sha256"
        $assets += [pscustomobject]@{
            name = $checksumName
            state = 'uploaded'
            browser_download_url = "https://github.com/x86-64-AVX512/eaw-localisation-hub/releases/download/$tag/$checksumName"
        }
    }
    [pscustomobject]@{ tag_name = $tag; draft = $Draft; assets = $assets }
}

$script:mockReleases = @(
    (New-TestRelease '0.8.8F7'),
    (New-TestRelease '0.8.8F9' -Draft $true),
    (New-TestRelease '0.8.8F8'),
    (New-TestRelease '0.8.8F10' -Complete $false),
    (New-TestRelease '0.8.8F6'),
    ([pscustomobject]@{
        tag_name = 'v.0.8.8F8'
        draft = $false
        assets = (New-TestRelease '0.8.8F8').assets
    })
)
function Invoke-RestMethod { $script:mockReleases }

$selected = Find-NewClientRelease -InstalledVersion '0.8.8F5'
if ($selected.Version -cne '0.8.8F8') { throw "Wrong installer selected: $($selected.Version)" }
$selected = Find-NewClientRelease -InstalledVersion '0.8.8F8'
if ($null -ne $selected) { throw 'Current release should not be selected for installation.' }
$legacyTagRelease = $script:mockReleases[-1]
$script:mockReleases = @((New-TestRelease '0.8.8F4'))
$selected = Find-NewClientRelease -InstalledVersion '0.8.8F5'
if ($null -ne $selected) { throw 'An older release must not replace a newer local client.' }
$script:mockReleases = @()
$selected = Find-NewClientRelease -InstalledVersion '0.8.8F5'
if ($null -ne $selected) { throw 'An empty release list must not trigger installation.' }
$script:mockReleases = @($legacyTagRelease)
$selected = Find-NewClientRelease -InstalledVersion '0.8.8F5'
if ($selected.Version -cne '0.8.8F8') { throw 'Existing v.X.Y.ZFN release tag was not recognized.' }
Remove-Item Function:Invoke-RestMethod

$rejected = $false
try {
    Assert-ReleaseDownloadUrl -Url 'https://example.com/EaW-Localisation-Hub-Setup-0.8.8F8.exe' `
        -ExpectedFileName 'EaW-Localisation-Hub-Setup-0.8.8F8.exe'
} catch { $rejected = $true }
if (-not $rejected) { throw 'Non-GitHub release URL was accepted.' }

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("EaWHubUpdaterTest-" + [Guid]::NewGuid().ToString('N'))
$resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$resolvedTest = [System.IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTest.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to create updater test files outside the temporary directory.'
}
$oldProcess = $null
$oldNode = ''
try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $stateRoot = $testRoot
    $statusPath = Join-Path $stateRoot 'update-status.json'
    Write-UpdateStatus -Stage 'downloading' -Message 'Загрузка обновления'
    $expectedMessage = 'Автообновление не удалось: версия F5 ещё не опубликована.'
    Write-UpdateStatus -Stage 'error' -Message $expectedMessage
    $status = Get-Content -LiteralPath $statusPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($status.Stage -cne 'error' -or $status.Message -cne $expectedMessage) {
        throw 'Updater status replacement or Unicode message round-trip failed.'
    }

    $version = '0.8.8F5'
    $installerName = "EaW-Localisation-Hub-Setup-$version.exe"
    $installerPath = Join-Path $testRoot $installerName
    [System.IO.File]::WriteAllBytes($installerPath, [byte[]](1, 2, 3, 4))
    $hash = Get-EawFileSha256 -LiteralPath $installerPath
    $checksumPath = "$installerPath.sha256"
    [System.IO.File]::WriteAllText($checksumPath, "$hash  $installerName`r`n", [System.Text.Encoding]::ASCII)
    $release = [pscustomobject]@{
        Version = $version
        InstallerName = $installerName
        Installer = [pscustomobject]@{ size = 4; digest = "sha256:$hash" }
    }
    Assert-ClientReleaseInstaller -Release $release -InstallerPath $installerPath -ChecksumPath $checksumPath
    [System.IO.File]::WriteAllBytes($installerPath, [byte[]](0, 2, 3, 4))
    $tamperRejected = $false
    try { Assert-ClientReleaseInstaller -Release $release -InstallerPath $installerPath -ChecksumPath $checksumPath }
    catch { $tamperRejected = $true }
    if (-not $tamperRejected) { throw 'Tampered installer passed SHA-256 verification.' }

    $script:installerInvocation = $null
    $script:installerExitCode = 0
    function Start-Process {
        param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
        $script:installerInvocation = [pscustomobject]@{
            FilePath = $FilePath; Arguments = @($ArgumentList); Verb = $Verb
            Wait = $Wait.IsPresent; PassThru = $PassThru.IsPresent
        }
        [pscustomobject]@{ ExitCode = $script:installerExitCode }
    }
    Invoke-ClientInstaller -InstallerPath $installerPath -InstallRoot 'C:\Program Files\EaW Localisation Hub'
    $invocation = $script:installerInvocation
    if ($invocation.Verb -cne 'RunAs' -or -not $invocation.Wait -or -not $invocation.PassThru -or
        '/VERYSILENT' -cnotin $invocation.Arguments -or
        '/NORESTART' -cnotin $invocation.Arguments -or
        '/DIR="C:\Program Files\EaW Localisation Hub"' -cnotin $invocation.Arguments) {
        throw 'Installer was not launched elevated, silently, and in the existing directory.'
    }
    $script:installerExitCode = 7
    $failureRejected = $false
    try { Invoke-ClientInstaller -InstallerPath $installerPath -InstallRoot 'C:\Program Files\EaW Localisation Hub' }
    catch { $failureRejected = $_.Exception.Message -match 'exit code 7' }
    if (-not $failureRejected) { throw 'A failed installer was accepted as a successful update.' }
    Remove-Item Function:Start-Process

    if ($Integration) {
        $builtVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw -Encoding utf8).Trim()
        $builtName = "EaW-Localisation-Hub-Setup-$builtVersion.exe"
        $builtInstaller = Join-Path $projectRoot "dist\$builtName"
        $builtChecksum = "$builtInstaller.sha256"
        if (-not (Test-Path -LiteralPath $builtInstaller -PathType Leaf) -or
            -not (Test-Path -LiteralPath $builtChecksum -PathType Leaf)) {
            throw 'Build the installer before running the update integration test.'
        }
        $builtHash = Get-EawFileSha256 -LiteralPath $builtInstaller
        $builtRelease = [pscustomobject]@{
            Version = $builtVersion
            InstallerName = $builtName
            Installer = [pscustomobject]@{
                size = (Get-Item -LiteralPath $builtInstaller).Length
                digest = "sha256:$builtHash"
            }
        }
        Assert-ClientReleaseInstaller -Release $builtRelease -InstallerPath $builtInstaller -ChecksumPath $builtChecksum
        $packageRoot = Join-Path $projectRoot "dist\EaW-Hub-Client-$builtVersion"
        $oldNode = Join-Path $packageRoot 'node.exe'
        if (-not (Test-Path -LiteralPath $oldNode -PathType Leaf)) {
            throw 'Build the client package before the process-switch integration test.'
        }
        $oldProcess = Start-Process -FilePath $oldNode -ArgumentList '-e "setInterval(()=>{},1000)"' `
            -WindowStyle Hidden -PassThru
        Start-Sleep -Milliseconds 200
        if ($oldProcess.HasExited) { throw 'The simulated old Agent did not start.' }
        $instance = [pscustomobject]@{
            schema = 1
            pid = $oldProcess.Id
            startedAt = $oldProcess.StartTime.ToUniversalTime().ToString('o')
        }
        [System.IO.File]::WriteAllText((Join-Path $stateRoot 'agent-instance.json'),
            ($instance | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
        $originalRoot = $projectRoot
        try {
            $projectRoot = $packageRoot
            Stop-CurrentClient
        } finally { $projectRoot = $originalRoot }
        $oldProcess.Refresh()
        if (-not $oldProcess.HasExited) { throw 'The simulated old Agent was not stopped.' }
        Write-Output "[client-updater-integration] installer integrity and simulated Agent stop passed ($builtVersion)"
    }

    if ($PublishedRelease) {
        $liveReleases = Microsoft.PowerShell.Utility\Invoke-RestMethod -Uri $releaseApi -Headers @{
            'Accept' = 'application/vnd.github+json'
            'User-Agent' = 'EaWLocalisationHub-Updater'
            'X-GitHub-Api-Version' = '2022-11-28'
        } -TimeoutSec 20
        Write-Output "[client-updater-published] found $(@($liveReleases).Count) release(s); first tag: $($liveReleases[0].tag_name)"
        $published = Find-NewClientRelease -InstalledVersion '0.8.8F4'
        if (-not $published -or $published.Version -cne '0.8.8F5') {
            throw 'The published F5 installer was not selected for an F4 client.'
        }
        $publishedInstaller = Join-Path $testRoot $published.InstallerName
        $publishedChecksum = "$publishedInstaller.sha256"
        Invoke-WebRequest -Uri $published.Installer.browser_download_url -UseBasicParsing -TimeoutSec 600 -OutFile $publishedInstaller
        Invoke-WebRequest -Uri $published.Checksum.browser_download_url -UseBasicParsing -TimeoutSec 30 -OutFile $publishedChecksum
        Assert-ClientReleaseInstaller -Release $published -InstallerPath $publishedInstaller -ChecksumPath $publishedChecksum
        Write-Output "[client-updater-published] GitHub installer download and SHA-256 verified ($($published.Version))"
    }

    if ($ReinstallCurrent) {
        $installedRoot = Join-Path $env:ProgramFiles 'EaW Localisation Hub'
        $installedBefore = Get-EawHubClientStatusMetadata -ProjectRoot $installedRoot
        $builtVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw -Encoding utf8).Trim()
        if ($installedBefore.Version -cne $builtVersion) {
            throw 'The installed client must already have the same version for this controlled reinstall test.'
        }
        $builtInstaller = Join-Path $projectRoot "dist\EaW-Localisation-Hub-Setup-$builtVersion.exe"
        $expectedUpdater = Join-Path $projectRoot "dist\EaW-Hub-Client-$builtVersion\scripts\update-client.ps1"
        if (-not (Test-Path -LiteralPath $builtInstaller -PathType Leaf) -or
            -not (Test-Path -LiteralPath $expectedUpdater -PathType Leaf)) {
            throw 'Build the client and installer before a controlled reinstall.'
        }
        Write-Output "[client-updater-reinstall] requesting Windows elevation for $builtVersion"
        Invoke-ClientInstaller -InstallerPath $builtInstaller -InstallRoot $installedRoot
        $installedAfter = Get-EawHubClientStatusMetadata -ProjectRoot $installedRoot
        $installedUpdater = Join-Path $installedRoot 'scripts\update-client.ps1'
        if ($installedAfter.Version -cne $builtVersion -or
            (Get-EawFileSha256 -LiteralPath $installedUpdater) -ine
            (Get-EawFileSha256 -LiteralPath $expectedUpdater)) {
            throw 'The installed client does not contain the rebuilt updater.'
        }
        if (Find-NewClientRelease -InstalledVersion $builtVersion) {
            throw 'A newer release appeared; refusing the same-version check because it would start an update.'
        }
        $ownerStartTicks = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
        & $installedUpdater -ProjectRoot $installedRoot -OwnerProcessId $PID -OwnerStartedAtTicks $ownerStartTicks
        $installedStatusPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EaWLocalisationHub\update-status.json'
        $installedStatus = Get-Content -LiteralPath $installedStatusPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($installedStatus.Stage -cne 'current' -or $installedStatus.Version -cne $builtVersion) {
            throw 'The installed updater did not recognize the published release as current.'
        }
        Write-Output "[client-updater-reinstall] installed updater hash verified ($builtVersion)"
    }
} finally {
    if (Get-Command Start-Process -CommandType Function -ErrorAction SilentlyContinue) {
        Remove-Item Function:Start-Process
    }
    if ($oldProcess) {
        try {
            $oldProcess.Refresh()
            if (-not $oldProcess.HasExited -and
                [string]::Equals($oldProcess.Path, $oldNode, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $oldProcess.Id -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    if (Test-Path -LiteralPath $resolvedTest) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force
    }
}
Write-Output '[client-updater-smoke] installer selection, integrity and elevation arguments passed'
