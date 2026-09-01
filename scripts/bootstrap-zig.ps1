$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$toolsDirectory = Join-Path $projectRoot '.tools'
$version = '0.13.0'
$expectedSha256 = 'd859994725ef9402381e557c60bb57497215682e355204d754ee3df75ee3c158'
$archive = Join-Path $toolsDirectory "zig-windows-x86_64-$version.zip"
$extractDirectory = Join-Path $toolsDirectory 'zig-extract'
$zigDirectory = Join-Path $extractDirectory "zig-windows-x86_64-$version"
$zigExecutable = Join-Path $zigDirectory 'zig.exe'

if (Test-Path -Path $zigExecutable) {
    Write-Output $zigExecutable
    exit 0
}

New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
if (-not (Test-Path -Path $archive)) {
    Invoke-WebRequest `
        -Uri "https://ziglang.org/download/$version/zig-windows-x86_64-$version.zip" `
        -OutFile $archive
}
$actualSha256 = (Get-EawFileSha256 -LiteralPath $archive).ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
    throw "Zig archive checksum mismatch. Expected $expectedSha256, received $actualSha256. Delete the archive and retry."
}
if (-not (Test-Path -Path $extractDirectory)) {
    Expand-Archive -Path $archive -DestinationPath $extractDirectory
}

if (-not (Test-Path -Path $zigExecutable)) {
    throw "Zig executable was not found after extraction: $zigExecutable"
}
Write-Output $zigExecutable
