param(
    [string]$NotepadInstallDirectory = (Join-Path $env:ProgramFiles 'Notepad++'),
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-prototype-common.ps1')
$paths = Get-LocalPrototypePaths
New-Item -ItemType Directory -Path $paths.RuntimeRoot, $paths.LogsDirectory -Force | Out-Null

$nodeModules = Join-Path $paths.ProjectRoot 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) {
    throw 'Node dependencies are missing. Run npm ci once in the project directory.'
}

if (-not $SkipBuild) {
    $buildLog = Join-Path $paths.LogsDirectory 'prepare-build.log'
    Push-Location $paths.ProjectRoot
    try {
        & npm.cmd run build:plugin *> $buildLog
        if ($LASTEXITCODE -ne 0) {
            throw "Plugin build failed. See $buildLog"
        }
    }
    finally {
        Pop-Location
    }
}

$notepadExecutable = Join-Path $NotepadInstallDirectory 'notepad++.exe'
if (-not (Test-Path -LiteralPath $notepadExecutable)) {
    throw "Notepad++ x64 was not found: $notepadExecutable"
}
$pluginDll = Join-Path $paths.PluginBuildDirectory 'EawLocalisationHub.dll'
if (-not (Test-Path -LiteralPath $pluginDll)) {
    throw "Plugin DLL was not found after build: $pluginDll"
}

foreach ($portable in @($paths.PortableA, $paths.PortableB)) {
    $portableExecutable = Join-Path $portable 'notepad++.exe'
    if (-not (Test-Path -LiteralPath $portableExecutable)) {
        New-Item -ItemType Directory -Path $portable -Force | Out-Null
        Get-ChildItem -LiteralPath $NotepadInstallDirectory |
            Where-Object { $_.Name -notin @('plugins', 'updater') } |
            Copy-Item -Destination $portable -Recurse
    }
    $pluginTarget = Join-Path $portable 'plugins\EawLocalisationHub'
    New-Item -ItemType Directory -Path $pluginTarget -Force | Out-Null
    Copy-Item -LiteralPath $pluginDll -Destination (Join-Path $pluginTarget 'EawLocalisationHub.dll') -Force
    $pluginReadme = Join-Path $paths.PluginBuildDirectory 'README.txt'
    if (Test-Path -LiteralPath $pluginReadme) {
        Copy-Item -LiteralPath $pluginReadme -Destination (Join-Path $pluginTarget 'README.txt') -Force
    }
    $localConfigMarker = Join-Path $portable 'doLocalConf.xml'
    if (-not (Test-Path -LiteralPath $localConfigMarker)) {
        [System.IO.File]::WriteAllText(
            $localConfigMarker,
            '<?xml version="1.0" encoding="UTF-8" ?>',
            [System.Text.UTF8Encoding]::new($false))
    }
}

[pscustomobject]@{
    Version = '0.8.7F1'
    PortableA = Join-Path $paths.PortableA 'notepad++.exe'
    PortableB = Join-Path $paths.PortableB 'notepad++.exe'
    WorkspaceA = $paths.WorkspaceA
    WorkspaceB = $paths.WorkspaceB
}
