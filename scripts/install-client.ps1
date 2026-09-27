param(
    [string]$InstallDirectory = '',
    [switch]$DoNotLaunch,
    [switch]$SkipShortcuts
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $sourceRoot 'VERSION') -Raw -Encoding utf8).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+F\d+$') { throw "Invalid client version: $version" }
if (-not $InstallDirectory) {
    $InstallDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Programs\EaW Localisation Hub\Client-$version"
}
$nodeSource = Join-Path $sourceRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodeSource)) { throw "Bundled Node.js is missing: $nodeSource" }

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
foreach ($name in @('apps', 'packages', 'scripts', 'node_modules', 'review')) {
    $source = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Client package is missing: $source" }
    Copy-Item -LiteralPath $source -Destination $InstallDirectory -Recurse -Force
}
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $InstallDirectory 'node.exe') -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Launch EaW Hub Agent.cmd') -Destination $InstallDirectory -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Launch EaW Hub Review.cmd') -Destination $InstallDirectory -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Launch EaW Hub Admin.cmd') -Destination $InstallDirectory -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Launch EaW Hub Team Management.cmd') -Destination $InstallDirectory -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'VERSION') -Destination $InstallDirectory -Force

if (-not $SkipShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcutTargets = @(
    [pscustomobject]@{ Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'EaW Localisation Hub Agent.lnk'); Command = 'Launch EaW Hub Agent.cmd' },
    [pscustomobject]@{ Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'EaW Localisation Hub Review.lnk'); Command = 'Launch EaW Hub Review.cmd' },
    [pscustomobject]@{ Path = (Join-Path ([Environment]::GetFolderPath('Programs')) 'EaW Localisation Hub Agent.lnk'); Command = 'Launch EaW Hub Agent.cmd' },
    [pscustomobject]@{ Path = (Join-Path ([Environment]::GetFolderPath('Programs')) 'EaW Localisation Hub Review.lnk'); Command = 'Launch EaW Hub Review.cmd' },
    [pscustomobject]@{ Path = (Join-Path ([Environment]::GetFolderPath('Programs')) 'EaW Localisation Hub Admin.lnk'); Command = 'Launch EaW Hub Admin.cmd' },
    [pscustomobject]@{ Path = (Join-Path ([Environment]::GetFolderPath('Programs')) 'EaW Localisation Hub Team Management.lnk'); Command = 'Launch EaW Hub Team Management.cmd' }
    )
    foreach ($shortcutDefinition in $shortcutTargets) {
        $shortcut = $shell.CreateShortcut($shortcutDefinition.Path)
        $shortcut.TargetPath = (Join-Path $InstallDirectory $shortcutDefinition.Command)
        $shortcut.WorkingDirectory = $InstallDirectory
        $shortcut.IconLocation = Join-Path $InstallDirectory 'review\EaWReview.exe'
        $shortcut.Save()
    }
}

$record = [pscustomobject]@{
    Version = $version
    InstalledAt = [DateTime]::UtcNow.ToString('o')
    InstallDirectory = $InstallDirectory
}
[System.IO.File]::WriteAllText(
    (Join-Path $InstallDirectory 'installation.json'),
    ($record | ConvertTo-Json),
    [System.Text.UTF8Encoding]::new($false))

if (-not $DoNotLaunch) {
    Start-Process -FilePath (Join-Path $InstallDirectory 'Launch EaW Hub Agent.cmd') -WorkingDirectory $InstallDirectory
}
$record
