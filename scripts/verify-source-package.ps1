param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$version = ([IO.File]::ReadAllText((Join-Path $projectRoot 'VERSION'))).Trim()
$packageRoot = Join-Path $projectRoot "dist\EaW-Localisation-Hub-Source-$version"
$archivePath = "$packageRoot.zip"
$checksumPath = "$archivePath.sha256"

foreach ($relative in @(
    'LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md',
    'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json',
    '.github\workflows\ci.yml', 'docs\RELEASING.md',
    'vendor\nlohmann-json\LICENSE.MIT',
    'vendor\nlohmann-json\single_include\nlohmann\json.hpp'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $relative) -PathType Leaf)) {
        throw "Source package is missing $relative"
    }
}

foreach ($relative in @(
    'apps\agent\review-web', 'data', 'dist', 'node_modules', 'output',
    'deploy\.env', 'deploy\backups', 'deploy\rollbacks'
)) {
    if (Test-Path -LiteralPath (Join-Path $packageRoot $relative)) {
        throw "Source package contains generated or private state: $relative"
    }
}

if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Source archive is missing: $archivePath" }
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw "Source checksum is missing: $checksumPath" }
$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw) -split '\s+')[0]
$actualHash = Get-EawFileSha256 -LiteralPath $archivePath
if ($expectedHash -ne $actualHash) { throw 'Source archive checksum does not match.' }
Write-Output '[source-package-smoke] source archive is clean and complete'
