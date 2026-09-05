param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $distRoot 'EaW-Hub-Client-0.8.7F1'))
if (-not $packageRoot.StartsWith($distRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to rebuild a package outside dist: $packageRoot"
}
if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'apps'), (Join-Path $packageRoot 'packages') -Force | Out-Null

$node = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $node -Destination (Join-Path $packageRoot 'node.exe')
$nodeLicense = Join-Path (Split-Path -Parent $node) 'LICENSE'
if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) { throw "Bundled Node.js license is missing: $nodeLicense" }
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $packageRoot 'THIRD-PARTY-NODE-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.md') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'vendor\nlohmann-json\LICENSE.MIT') -Destination (Join-Path $packageRoot 'THIRD-PARTY-NLOHMANN-JSON-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $projectRoot 'apps\agent') -Destination (Join-Path $packageRoot 'apps\agent') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'packages\shared') -Destination (Join-Path $packageRoot 'packages\shared') -Recurse
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'node_modules') -Force | Out-Null
# Agent executes only these production packages. Monaco and build tooling are already
# bundled into review-web and must not inflate the redistributable client.
foreach ($moduleName in @('isomorphic.js', 'lib0', 'ws', 'yjs')) {
    $moduleSource = Join-Path (Join-Path $projectRoot 'node_modules') $moduleName
    if (-not (Test-Path -LiteralPath $moduleSource -PathType Container)) {
        throw "Runtime dependency is missing: $moduleSource"
    }
    Copy-Item -LiteralPath $moduleSource -Destination (Join-Path $packageRoot 'node_modules') -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'scripts'), (Join-Path $packageRoot 'plugin') -Force | Out-Null
foreach ($scriptName in @(
    'start-agent-ui.ps1',
    'agent-status.ps1',
    'start-review.ps1',
    'credential-store.ps1',
    'install-client.ps1',
    'server-admin-ui.ps1',
    'backup-server.ps1',
    'install-backup-task.ps1',
    'set-backup-passphrase.ps1',
    'manage-server.mjs'
)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $scriptName) `
        -Destination (Join-Path (Join-Path $packageRoot 'scripts') $scriptName)
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist\EawLocalisationHub\EawLocalisationHub.dll') `
    -Destination (Join-Path $packageRoot 'plugin\EawLocalisationHub.dll')
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist\EawReview') `
    -Destination (Join-Path $packageRoot 'review') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'VERSION') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'Launch EaW Hub Agent.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'Launch EaW Hub Review.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'Launch EaW Hub Admin.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'Launch EaW Hub Team Management.cmd') -Destination $packageRoot
[System.IO.File]::WriteAllText(
    (Join-Path $packageRoot 'Install EaW Hub Client.cmd'),
    "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0scripts\install-client.ps1`"`r`npause`r`n",
    [System.Text.Encoding]::ASCII)

$archivePath = [System.IO.Path]::GetFullPath((Join-Path $distRoot 'EaW-Hub-Client-0.8.7F1.zip'))
$checksumPath = "$archivePath.sha256"
if (-not $archivePath.StartsWith($distRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create an archive outside dist: $archivePath"
}
Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $archivePath -CompressionLevel Optimal -Force
$archiveHash = (Get-EawFileSha256 -LiteralPath $archivePath).ToLowerInvariant()
[System.IO.File]::WriteAllText($checksumPath, "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))`n", [System.Text.Encoding]::ASCII)
Write-Output "[client-package] $packageRoot"
Write-Output "[client-archive] $archivePath"
Write-Output "[client-checksum] $checksumPath"
