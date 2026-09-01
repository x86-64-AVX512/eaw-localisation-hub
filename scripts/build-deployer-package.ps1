param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$distRoot = Join-Path $projectRoot 'dist'
$version = ([IO.File]::ReadAllText((Join-Path $projectRoot 'VERSION'))).Trim()
$packageRoot = Join-Path $distRoot "EaW-Hub-Deployer-$version"
$archivePath = "$packageRoot.zip"
$checksumPath = "$archivePath.sha256"
if (-not ([IO.Path]::GetFullPath($packageRoot)).StartsWith(([IO.Path]::GetFullPath($distRoot)) + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to create a deployer package outside dist.'
}
if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination (Join-Path $packageRoot 'node.exe')
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$nodeLicense = Join-Path (Split-Path -Parent $nodeExecutable) 'LICENSE'
if (-not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) { throw "Bundled Node.js license is missing: $nodeLicense" }
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $packageRoot 'THIRD-PARTY-NODE-LICENSE.txt')
foreach ($relative in @('Dockerfile', 'package.json', 'package-lock.json', 'VERSION', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Launch EaW Hub Deployer.cmd')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination (Join-Path $packageRoot $relative)
}
foreach ($relative in @('apps\deployer', 'apps\server', 'packages\shared')) {
    $destination = Join-Path $packageRoot $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination $destination -Recurse
}
$deployDestination = Join-Path $packageRoot 'deploy'
New-Item -ItemType Directory -Path $deployDestination -Force | Out-Null
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectRoot 'deploy') -File) {
    if ($file.Name -eq '.env' -or $file.Name -like '*.log' -or $file.Name -like '*.tmp') { continue }
    Copy-Item -LiteralPath $file.FullName -Destination $deployDestination
}
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'scripts') -Force | Out-Null
foreach ($scriptName in @('deploy-server-ui.ps1', 'manage-server.mjs')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\$scriptName") -Destination (Join-Path $packageRoot 'scripts')
}
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'node_modules') -Force | Out-Null
foreach ($moduleName in @('ssh2', 'asn1', 'bcrypt-pbkdf', 'safer-buffer', 'tweetnacl')) {
    $source = Join-Path $projectRoot "node_modules\$moduleName"
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $packageRoot 'node_modules') -Recurse }
}
Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $archivePath -CompressionLevel Optimal
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($checksumPath, "$archiveHash  $([IO.Path]::GetFileName($archivePath))`n", [Text.Encoding]::ASCII)
Write-Output "[deployer-package] $packageRoot"
Write-Output "[deployer-archive] $archivePath"
Write-Output "[deployer-checksum] $checksumPath"
