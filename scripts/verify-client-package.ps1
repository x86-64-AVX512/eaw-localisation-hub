param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$expectedVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw -Encoding utf8).Trim()
$packageRoot = Join-Path $projectRoot "dist\EaW-Hub-Client-$expectedVersion"
$archivePath = Join-Path $projectRoot "dist\EaW-Hub-Client-$expectedVersion.zip"
$checksumPath = "$archivePath.sha256"
$required = @(
    'node.exe',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'THIRD-PARTY-NODE-LICENSE.txt',
    'VERSION',
    'Install EaW Hub Client.cmd',
    'Launch EaW Hub Agent.cmd',
    'Launch EaW Hub Review.cmd',
    'Launch EaW Hub Admin.cmd',
    'Launch EaW Hub Team Management.cmd',
    'apps\agent\src\main.mjs',
    'packages\shared\src\constants.mts',
    'scripts\start-agent-ui.ps1',
    'scripts\start-hub.ps1',
    'scripts\agent-status.ps1',
    'scripts\hash-utils.ps1',
    'scripts\update-client.ps1',
    'scripts\start-review.ps1',
    'scripts\credential-store.ps1',
    'scripts\install-client.ps1',
    'scripts\server-admin-ui.ps1',
    'scripts\admin-audit-ui.ps1',
    'scripts\backup-server.ps1',
    'scripts\install-backup-task.ps1',
    'scripts\backup-schedule.ps1',
    'scripts\set-backup-passphrase.ps1',
    'scripts\manage-server.mjs',
    'review\EaWReview.exe',
    'review\WebView2Loader.dll',
    'apps\agent\review-web\index.html',
    'apps\agent\review-web\app.js',
    'apps\agent\review-web\app.css',
    'apps\agent\review-web\editor.worker.js',
    'apps\agent\review-web\spellcheck-worker.js',
    'apps\agent\review-web\syntax-worker.js',
    'node_modules\ws\package.json',
    'node_modules\yjs\package.json'
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $relative))) {
        throw "Client package is missing $relative"
    }
}
$updaterBytes = [System.IO.File]::ReadAllBytes((Join-Path $packageRoot 'scripts\update-client.ps1'))
if ($updaterBytes.Length -lt 3 -or $updaterBytes[0] -ne 0xEF -or
    $updaterBytes[1] -ne 0xBB -or $updaterBytes[2] -ne 0xBF) {
    throw 'Packaged updater needs a UTF-8 BOM for Windows PowerShell 5.1.'
}
if (Test-Path -LiteralPath (Join-Path $packageRoot 'plugin')) {
    throw 'Client package must not contain the removed Notepad++ plugin.'
}
$version = (Get-Content -LiteralPath (Join-Path $packageRoot 'VERSION') -Raw -Encoding utf8).Trim()
if ($version -ne $expectedVersion) { throw "Unexpected client package version: $version" }
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Client archive is missing: $archivePath" }
if ((Get-Item -LiteralPath $archivePath).Length -lt 1MB) { throw 'Client archive is unexpectedly small.' }
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw "Client checksum is missing: $checksumPath" }
$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw) -split '\s+')[0]
$actualHash = Get-EawFileSha256 -LiteralPath $archivePath
if ($expectedHash -ne $actualHash) { throw 'Client archive checksum does not match.' }
Write-Output "[client-package-smoke] verified $($required.Count) required artifact(s)"
