param(
    [string]$NotepadInstallDirectory = (Join-Path $env:ProgramFiles 'Notepad++'),
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'EaWLocalisationHub\Client-0.8.7F1'),
    [switch]$DoNotLaunch,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
if (-not $Elevated) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"' +
            ' -NotepadInstallDirectory "' + $NotepadInstallDirectory + '"' +
            ' -InstallDirectory "' + $InstallDirectory + '" -Elevated'
        if ($DoNotLaunch) { $arguments += ' -DoNotLaunch' }
        $process = Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Elevated installer failed with exit code $($process.ExitCode)." }
        return
    }
}
$sourceRoot = Split-Path -Parent $PSScriptRoot
$pluginSource = Join-Path $sourceRoot 'plugin\EawLocalisationHub.dll'
$nodeSource = Join-Path $sourceRoot 'node.exe'
if (-not (Test-Path -LiteralPath $pluginSource)) { throw "Client package is incomplete: $pluginSource" }
if (-not (Test-Path -LiteralPath $nodeSource)) { throw "Bundled Node.js is missing: $nodeSource" }
$notepadExecutable = Join-Path $NotepadInstallDirectory 'notepad++.exe'
if (-not (Test-Path -LiteralPath $notepadExecutable)) { throw "Notepad++ x64 was not found: $notepadExecutable" }
if (Get-Process notepad++ -ErrorAction SilentlyContinue) {
    throw 'Close all Notepad++ windows before installing or updating the plugin.'
}

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

$pluginTarget = Join-Path $NotepadInstallDirectory 'plugins\EawLocalisationHub'
New-Item -ItemType Directory -Path $pluginTarget -Force | Out-Null
$installedDll = Join-Path $pluginTarget 'EawLocalisationHub.dll'
if (Test-Path -LiteralPath $installedDll) {
    $backup = "$installedDll.before-0.8.7F1-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.bak'
    Copy-Item -LiteralPath $installedDll -Destination $backup -Force
}
Copy-Item -LiteralPath $pluginSource -Destination $installedDll -Force

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
    $shortcut.IconLocation = $notepadExecutable
    $shortcut.Save()
}

$record = [pscustomobject]@{
    Version = '0.8.7F1'
    InstalledAt = [DateTime]::UtcNow.ToString('o')
    InstallDirectory = $InstallDirectory
    NotepadInstallDirectory = $NotepadInstallDirectory
}
[System.IO.File]::WriteAllText(
    (Join-Path $InstallDirectory 'installation.json'),
    ($record | ConvertTo-Json),
    [System.Text.UTF8Encoding]::new($false))

if (-not $DoNotLaunch) {
    Start-Process -FilePath (Join-Path $InstallDirectory 'Launch EaW Hub Agent.cmd') -WorkingDirectory $InstallDirectory
}
$record
