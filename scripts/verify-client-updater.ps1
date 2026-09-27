param([switch]$Integration)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'update-client.ps1') -ProjectRoot $projectRoot -OwnerProcessId 2147483647 -OwnerStartedAtTicks 0

function New-TestRelease {
    param([string]$Version, [bool]$Draft = $false, [bool]$Complete = $true)
    $tag = [regex]::Replace($Version, '^(\d+\.\d+\.\d+)F(\d+)$', 'v$1-beta.$2')
    $archiveName = "EaW-Hub-Client-$Version.zip"
    $assets = @(
        [pscustomobject]@{
            name = $archiveName
            state = 'uploaded'
            browser_download_url = "https://github.com/x86-64-AVX512/eaw-localisation-hub/releases/download/$tag/$archiveName"
        }
    )
    if ($Complete) {
        $checksumName = "$archiveName.sha256"
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
if ($selected.Version -cne '0.8.8F8') { throw "Wrong release selected: $($selected.Version)" }
$selected = Find-NewClientRelease -InstalledVersion '0.8.8F8'
if ($null -ne $selected) { throw 'Current release should not be selected for installation.' }
$legacyTagRelease = $script:mockReleases[-1]
$script:mockReleases = @((New-TestRelease '0.8.8F4'))
$selected = Find-NewClientRelease -InstalledVersion '0.8.8F5'
if ($null -ne $selected) { throw 'An older published release must not replace a newer local client.' }
$script:mockReleases = @()
$selected = Find-NewClientRelease -InstalledVersion '0.8.8F5'
if ($null -ne $selected) { throw 'An empty release list must not trigger installation.' }
$script:mockReleases = @($legacyTagRelease)
$selected = Find-NewClientRelease -InstalledVersion '0.8.8F5'
if ($selected.Version -cne '0.8.8F8') { throw 'Existing v.X.Y.ZFN release tag was not recognized.' }

$rejected = $false
try {
    Assert-ReleaseDownloadUrl -Url 'https://example.com/EaW-Hub-Client-0.8.8F8.zip' `
        -ExpectedFileName 'EaW-Hub-Client-0.8.8F8.zip'
} catch { $rejected = $true }
if (-not $rejected) { throw 'Non-GitHub release URL was accepted.' }

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("EaWHubUpdaterTest-" + [Guid]::NewGuid().ToString('N'))
$resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$resolvedTest = [System.IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTest.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to create updater test files outside the temporary directory.'
}
try {
    $stateRoot = $testRoot
    $statusPath = Join-Path $stateRoot 'update-status.json'
    Write-UpdateStatus -Stage 'downloading' -Message 'Загрузка обновления'
    $expectedMessage = 'Автообновление не удалось: версия F5 ещё не опубликована.'
    Write-UpdateStatus -Stage 'error' -Message $expectedMessage
    $status = Get-Content -LiteralPath $statusPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($status.Stage -cne 'error' -or $status.Message -cne $expectedMessage) {
        throw 'Updater status replacement or Unicode message round-trip failed.'
    }
    $sample = Join-Path $testRoot 'sample.txt'
    [System.IO.File]::WriteAllText($sample, 'client archive test')
    $sampleArchive = Join-Path $testRoot 'sample.zip'
    Compress-Archive -LiteralPath $sample -DestinationPath $sampleArchive
    $unpacked = Join-Path $testRoot 'unpacked'
    Expand-CheckedClientArchive -ArchivePath $sampleArchive -Destination $unpacked
    if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'sample.txt') -PathType Leaf)) {
        throw 'Checked client archive extraction failed.'
    }
    $maliciousArchive = Join-Path $testRoot 'traversal.zip'
    $zip = [System.IO.Compression.ZipFile]::Open($maliciousArchive, [System.IO.Compression.ZipArchiveMode]::Create)
    try { [void]$zip.CreateEntry('../escape.txt') } finally { $zip.Dispose() }
    $traversalRejected = $false
    try {
        Expand-CheckedClientArchive -ArchivePath $maliciousArchive -Destination (Join-Path $testRoot 'unsafe')
    } catch { $traversalRejected = $true }
    if (-not $traversalRejected) { throw 'Archive path traversal was accepted.' }
    if ($Integration) {
        $version = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw -Encoding utf8).Trim()
        $archiveName = "EaW-Hub-Client-$version.zip"
        $sourceArchive = Join-Path $projectRoot "dist\$archiveName"
        $sourceChecksum = "$sourceArchive.sha256"
        if (-not (Test-Path -LiteralPath $sourceArchive -PathType Leaf) -or
            -not (Test-Path -LiteralPath $sourceChecksum -PathType Leaf)) {
            throw 'Build the client package before running the update integration test.'
        }
        $downloadRoot = Join-Path $testRoot 'download'
        New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
        $downloadedArchive = Join-Path $downloadRoot $archiveName
        $downloadedChecksum = "$downloadedArchive.sha256"
        Copy-Item -LiteralPath $sourceArchive -Destination $downloadedArchive
        Copy-Item -LiteralPath $sourceChecksum -Destination $downloadedChecksum
        $archiveHash = Get-EawFileSha256 -LiteralPath $downloadedArchive
        $release = [pscustomobject]@{
            Version = $version
            ArchiveName = $archiveName
            Archive = [pscustomobject]@{
                size = (Get-Item -LiteralPath $downloadedArchive).Length
                digest = "sha256:$archiveHash"
            }
        }
        Assert-ClientReleaseArchive -Release $release -ArchivePath $downloadedArchive -ChecksumPath $downloadedChecksum

        $tampered = Join-Path $testRoot 'tampered.zip'
        Copy-Item -LiteralPath $downloadedArchive -Destination $tampered
        $stream = [System.IO.File]::Open($tampered, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite)
        try {
            $firstByte = $stream.ReadByte()
            $stream.Position = 0
            $stream.WriteByte([byte]($firstByte -bxor 1))
        } finally { $stream.Dispose() }
        $tamperRejected = $false
        try {
            Assert-ClientReleaseArchive -Release $release -ArchivePath $tampered -ChecksumPath $downloadedChecksum
        } catch { $tamperRejected = $true }
        if (-not $tamperRejected) { throw 'Tampered client archive passed SHA-256 verification.' }

        $packageRoot = Join-Path $testRoot 'client-package'
        Expand-CheckedClientArchive -ArchivePath $downloadedArchive -Destination $packageRoot
        Assert-ClientPackage -PackageRoot $packageRoot -Version $version
        $wrongVersionRejected = $false
        try { Assert-ClientPackage -PackageRoot $packageRoot -Version '0.0.0F0' }
        catch { $wrongVersionRejected = $true }
        if (-not $wrongVersionRejected) { throw 'Package version mismatch was accepted.' }
        $installedRoot = Join-Path $testRoot "installed\Client-$version"
        & (Join-Path $packageRoot 'scripts\install-client.ps1') `
            -InstallDirectory $installedRoot -DoNotLaunch -SkipShortcuts | Out-Null
        $installation = Get-Content -LiteralPath (Join-Path $installedRoot 'installation.json') -Raw -Encoding utf8 | ConvertFrom-Json
        if ($installation.Version -cne $version -or $installation.InstallDirectory -cne $installedRoot) {
            throw 'Side-by-side test installation has incorrect metadata.'
        }
        foreach ($required in @('node.exe', 'scripts\start-agent-ui.ps1', 'review\EaWReview.exe')) {
            if (-not (Test-Path -LiteralPath (Join-Path $installedRoot $required) -PathType Leaf)) {
                throw "Test installation is missing $required"
            }
        }

        $stateRoot = $testRoot
        $projectRoot = $packageRoot
        $oldNode = Join-Path $packageRoot 'node.exe'
        $oldProcess = Start-Process -FilePath $oldNode -ArgumentList '-e "setInterval(()=>{},1000)"' `
            -WindowStyle Hidden -PassThru
        Start-Sleep -Milliseconds 200
        if ($oldProcess.HasExited) { throw 'The simulated old Agent did not start.' }
        $instance = [pscustomobject]@{
            schema = 1
            pid = $oldProcess.Id
            startedAt = $oldProcess.StartTime.ToUniversalTime().ToString('o')
        }
        [System.IO.File]::WriteAllText(
            (Join-Path $stateRoot 'agent-instance.json'),
            ($instance | ConvertTo-Json -Compress),
            [System.Text.UTF8Encoding]::new($false))
        Stop-CurrentClient
        $oldProcess.Refresh()
        if (-not $oldProcess.HasExited) { throw 'The simulated old Agent was not stopped.' }
        $newNodeVersion = & (Join-Path $installedRoot 'node.exe') --version
        if ($LASTEXITCODE -ne 0 -or $newNodeVersion -notmatch '^v\d+') {
            throw 'The newly installed client runtime did not start.'
        }
        Write-Output "[client-updater-integration] download copy, integrity, extraction, install and process switch passed ($version)"
    }
} finally {
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
Write-Output '[client-updater-smoke] release selection and asset URL validation passed'
