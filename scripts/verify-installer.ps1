param([switch]$RequireBuilt)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$displayVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw -Encoding utf8).Trim()
$definitionPath = Join-Path $projectRoot 'installer\EaWLocalisationHub.iss'
$definition = Get-Content -LiteralPath $definitionPath -Raw -Encoding utf8

$requiredPatterns = @(
    'PrivilegesRequired=admin',
    'ArchitecturesAllowed=x64compatible',
    'CloseApplicationsFilter=notepad++.exe',
    'DestDir: "{code:GetNotepadPluginDirectory}"',
    "OutputBaseFilename=EaW-Localisation-Hub-Setup-{#AppVersion}",
    'GetBinaryTypeW@kernel32.dll',
    'IsWebView2Installed',
    "WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'",
    'EaWLocalisationHubAgent'
)
foreach ($pattern in $requiredPatterns) {
    if (-not $definition.Contains($pattern)) { throw "Installer definition is missing: $pattern" }
}
if ($definition -match '(?im)^Name:\s*"[^\"]*plugin') {
    throw 'The mandatory Notepad++ plugin must not be exposed as an optional task.'
}

$output = Join-Path $projectRoot "dist\EaW-Localisation-Hub-Setup-$displayVersion.exe"
if ($RequireBuilt -and -not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw "Built installer is missing: $output"
}
if (Test-Path -LiteralPath $output -PathType Leaf) {
    $item = Get-Item -LiteralPath $output
    if ($item.Length -lt 1MB) { throw "Installer is unexpectedly small: $($item.Length) bytes" }
    $checksumPath = "$output.sha256"
    if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
        throw "Installer checksum is missing: $checksumPath"
    }
    $expected = ((Get-Content -LiteralPath $checksumPath -Raw -Encoding ascii) -split '\s+')[0]
    $actual = (Get-EawFileSha256 -LiteralPath $output).ToLowerInvariant()
    if ($expected -ne $actual) { throw 'Installer SHA-256 file does not match the built executable.' }
    Write-Output "[installer-smoke] $($item.Name), $([Math]::Round($item.Length / 1MB, 1)) MiB"
} else {
    Write-Output '[installer-smoke] definition verified; binary was not required'
}
