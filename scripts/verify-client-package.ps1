param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $projectRoot 'dist\EaW-Hub-Client-0.8.6F4'
$archivePath = Join-Path $projectRoot 'dist\EaW-Hub-Client-0.8.6F4.zip'
$checksumPath = "$archivePath.sha256"
$required = @(
    'node.exe',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'THIRD-PARTY-NODE-LICENSE.txt',
    'THIRD-PARTY-NLOHMANN-JSON-LICENSE.txt',
    'VERSION',
    'Install EaW Hub Client.cmd',
    'Launch EaW Hub Agent.cmd',
    'Launch EaW Hub Review.cmd',
    'Launch EaW Hub Admin.cmd',
    'Launch EaW Hub Team Management.cmd',
    'apps\agent\src\main.mjs',
    'packages\shared\src\constants.mjs',
    'scripts\start-agent-ui.ps1',
    'scripts\agent-status.ps1',
    'scripts\start-review.ps1',
    'scripts\credential-store.ps1',
    'scripts\install-client.ps1',
    'scripts\server-admin-ui.ps1',
    'scripts\backup-server.ps1',
    'scripts\install-backup-task.ps1',
    'scripts\set-backup-passphrase.ps1',
    'scripts\manage-server.mjs',
    'plugin\EawLocalisationHub.dll',
    'review\EaWReview.exe',
    'review\WebView2Loader.dll',
    'apps\agent\review-web\index.html',
    'apps\agent\review-web\app.js',
    'apps\agent\review-web\app.css',
    'apps\agent\review-web\editor.worker.js',
    'node_modules\ws\package.json',
    'node_modules\yjs\package.json'
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $relative))) {
        throw "Client package is missing $relative"
    }
}
$version = (Get-Content -LiteralPath (Join-Path $packageRoot 'VERSION') -Raw -Encoding utf8).Trim()
if ($version -ne '0.8.6F4') { throw "Unexpected client package version: $version" }
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Client archive is missing: $archivePath" }
if ((Get-Item -LiteralPath $archivePath).Length -lt 1MB) { throw 'Client archive is unexpectedly small.' }
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw "Client checksum is missing: $checksumPath" }
$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw) -split '\s+')[0]
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($expectedHash -ne $actualHash) { throw 'Client archive checksum does not match.' }
Write-Output "[client-package-smoke] verified $($required.Count) required artifact(s)"
