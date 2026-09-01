param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = ([IO.File]::ReadAllText((Join-Path $projectRoot 'VERSION'))).Trim()
$packageRoot = Join-Path $projectRoot "dist\EaW-Hub-Deployer-$version"
$archivePath = "$packageRoot.zip"
$checksumPath = "$archivePath.sha256"
$required = @(
    'node.exe', 'VERSION', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD-PARTY-NODE-LICENSE.txt',
    'Launch EaW Hub Deployer.cmd', 'apps\deployer\src\main.mjs',
    'apps\deployer\src\deployment-core.mjs', 'apps\server\src\main.mjs',
    'packages\shared\src\constants.mjs', 'scripts\deploy-server-ui.ps1',
    'scripts\manage-server.mjs', 'deploy\Dockerfile.incremental', 'node_modules\ssh2\package.json'
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $relative))) {
        throw "Deployer package is missing $relative"
    }
}
foreach ($forbidden in @('deploy\.env', 'deploy\backups', 'deploy\rollbacks')) {
    if (Test-Path -LiteralPath (Join-Path $packageRoot $forbidden)) {
        throw "Deployer package contains private runtime state: $forbidden"
    }
}
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Deployer archive is missing: $archivePath" }
if ((Get-Item -LiteralPath $archivePath).Length -lt 1MB) { throw 'Deployer archive is unexpectedly small.' }
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw "Deployer checksum is missing: $checksumPath" }
$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw) -split '\s+')[0]
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($expectedHash -ne $actualHash) { throw 'Deployer archive checksum does not match.' }
Write-Output "[deployer-package-smoke] verified $($required.Count) required artifact(s)"
