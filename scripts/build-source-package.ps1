param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $distRoot 'EaW-Localisation-Hub-Source-0.8.7F1'))
$archivePath = [System.IO.Path]::GetFullPath((Join-Path $distRoot 'EaW-Localisation-Hub-Source-0.8.7F1.zip'))
$checksumPath = "$archivePath.sha256"
if (-not $packageRoot.StartsWith($distRoot + '\', [StringComparison]::OrdinalIgnoreCase) `
    -or -not $archivePath.StartsWith($distRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to create a source package outside dist.'
}

if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

$rootFiles = @(
    '.dockerignore', '.editorconfig', '.gitattributes', '.gitignore', '.gitmodules',
    'Dockerfile', 'README.md', 'CHANGELOG.md', 'VERSION', 'LICENSE',
    'SECURITY.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md',
    'package.json', 'package-lock.json',
    'Launch EaW Hub Admin.cmd', 'Launch EaW Hub Team Management.cmd', 'Launch EaW Hub Agent.cmd', 'Launch EaW Hub Review.cmd',
    'Launch EaW Hub Prototype.cmd', 'Launch EaW Hub Deployer.cmd'
)
foreach ($relative in $rootFiles) {
    $source = Join-Path $projectRoot $relative
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $packageRoot $relative)
    }
}

$sourceDirectories = @('.github', 'apps', 'deploy', 'docs', 'installer', 'packages', 'plugin', 'scripts', 'test')
$excludedDirectoryNames = @('.git', '.tools', 'backups', 'data', 'dist', 'node_modules', 'review-web', 'rollbacks')
$excludedFileNames = @('.env', 'auth.json', 'bootstrap-invite.txt')
foreach ($directoryName in $sourceDirectories) {
    $sourceDirectory = Join-Path $projectRoot $directoryName
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse) {
        $relative = $file.FullName.Substring($projectRoot.Length).TrimStart('\', '/')
        $segments = $relative -split '[\\/]'
        if (@($segments | Where-Object { $_ -in $excludedDirectoryNames }).Count -gt 0) { continue }
        if ($file.Name -in $excludedFileNames -or $file.Name -like '*.log' -or $file.Name -like '*.tmp') { continue }
        $destination = Join-Path $packageRoot $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination
    }
}

# The plugin needs only the Notepad++ SDK headers and nlohmann's amalgamated header.
# Do not copy entire dependency repositories (tests, CI files and generated artifacts).
$nppVendorRoot = Join-Path $projectRoot 'vendor\npp-plugin-template'
if (Test-Path -LiteralPath $nppVendorRoot -PathType Container) {
    foreach ($file in Get-ChildItem -LiteralPath $nppVendorRoot -File -Recurse) {
        $relativeWithinVendor = $file.FullName.Substring($nppVendorRoot.Length).TrimStart('\', '/')
        if (($relativeWithinVendor -split '[\/]') -contains '.git') { continue }
        $destination = Join-Path $packageRoot (Join-Path 'vendor\npp-plugin-template' $relativeWithinVendor)
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination
    }
}
$nlohmannFiles = @(
    'vendor\nlohmann-json\single_include\nlohmann\json.hpp',
    'vendor\nlohmann-json\LICENSE.MIT'
)
foreach ($relative in $nlohmannFiles) {
    $source = Join-Path $projectRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required vendored source is missing: $relative"
    }
    $destination = Join-Path $packageRoot $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}

$forbidden = Get-ChildItem -LiteralPath $packageRoot -File -Recurse | Where-Object {
    $_.Name -in $excludedFileNames -or $_.Name -like '*.log' -or
    (($_.FullName.Substring($packageRoot.Length).TrimStart('\', '/') -split '[\\/]') |
        Where-Object { $_ -in $excludedDirectoryNames })
}
if ($forbidden) { throw "Clean source package contains a forbidden runtime artifact: $($forbidden[0].FullName)" }

$unexpectedNlohmann = Get-ChildItem -LiteralPath (Join-Path $packageRoot 'vendor\nlohmann-json') -File -Recurse |
    Where-Object {
        $relative = $_.FullName.Substring($packageRoot.Length).TrimStart('\', '/').Replace('\', '/')
        $relative -notin @(
            'vendor/nlohmann-json/LICENSE.MIT',
            'vendor/nlohmann-json/single_include/nlohmann/json.hpp'
        )
    }
if ($unexpectedNlohmann) {
    throw "Source package contains an unexpected nlohmann-json artifact: $($unexpectedNlohmann[0].FullName)"
}

Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $archivePath -CompressionLevel Optimal
$archiveHash = (Get-EawFileSha256 -LiteralPath $archivePath).ToLowerInvariant()
[System.IO.File]::WriteAllText($checksumPath, "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))`n", [System.Text.Encoding]::ASCII)
Write-Output "[source-package] $packageRoot"
Write-Output "[source-archive] $archivePath"
Write-Output "[source-checksum] $checksumPath"
