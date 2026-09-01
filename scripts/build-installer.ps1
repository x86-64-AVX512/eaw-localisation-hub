param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$displayVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw -Encoding utf8).Trim()
$packageMetadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$windowsFileVersion = [string]$packageMetadata.eawHub.windowsFileVersion
if ($windowsFileVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw "Invalid eawHub.windowsFileVersion in package.json: $windowsFileVersion"
}
$payloadDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $projectRoot "dist\EaW-Hub-Client-$displayVersion"))
$definition = Join-Path $projectRoot 'installer\EaWLocalisationHub.iss'
$output = Join-Path $projectRoot "dist\EaW-Localisation-Hub-Setup-$displayVersion.exe"
$checksumOutput = "$output.sha256"

if (-not (Test-Path -LiteralPath $definition -PathType Leaf)) {
    throw "Inno Setup definition is missing: $definition"
}
if (-not (Test-Path -LiteralPath (Join-Path $payloadDirectory 'plugin\EawLocalisationHub.dll') -PathType Leaf)) {
    throw "Build the client package first; installer payload is missing: $payloadDirectory"
}

$compilerCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) {
    $command = Get-Command iscc.exe -ErrorAction SilentlyContinue
    if ($command) { $compiler = $command.Source }
}
if (-not $compiler) {
    throw 'Inno Setup 6 was not found. Install it with: winget install --id JRSoftware.InnoSetup -e'
}

& $compiler '/Qp' "/DAppVersion=$displayVersion" "/DWindowsFileVersion=$windowsFileVersion" `
    "/DPayloadDir=$payloadDirectory" $definition
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "Installer output is missing: $output" }
$checksum = (Get-EawFileSha256 -LiteralPath $output).ToLowerInvariant()
[System.IO.File]::WriteAllText(
    $checksumOutput,
    "$checksum  $([System.IO.Path]::GetFileName($output))`r`n",
    [System.Text.Encoding]::ASCII)

Write-Output "[windows-installer] $output"
Write-Output "[windows-installer-sha256] $checksumOutput"
