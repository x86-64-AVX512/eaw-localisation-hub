$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-prototype-common.ps1')
$paths = Get-LocalPrototypePaths

if (Test-Path -LiteralPath $paths.StatePath) {
    $state = Get-Content -LiteralPath $paths.StatePath -Raw -Encoding utf8 | ConvertFrom-Json
    $running = @($state.Processes) | Where-Object {
        Test-OwnedProcess -Id ([int]$_.Id) -ExpectedExecutable ([string]$_.Executable) -CommandMarker ([string]$_.CommandMarker)
    }
    if ($running.Count -gt 0) {
        throw 'Stop the local prototype before resetting its test data.'
    }
}

$runtimeRoot = [System.IO.Path]::GetFullPath($paths.RuntimeRoot).TrimEnd('\') + '\'
$targets = @(
    $paths.WorkspaceA,
    $paths.WorkspaceB,
    $paths.ServerDataDirectory,
    $paths.ProtectedServerDataDirectory,
    $paths.AgentStateA,
    $paths.AgentStateB,
    $paths.GitOriginDirectory,
    $paths.GitPublisherDirectory
)
$backupDirectory = Join-Path $paths.RuntimeRoot ("backups\reset-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
foreach ($target in $targets) {
    $resolvedTarget = [System.IO.Path]::GetFullPath($target)
    if (-not $resolvedTarget.StartsWith($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset a path outside the local prototype runtime: $resolvedTarget"
    }
    if (Test-Path -LiteralPath $resolvedTarget) {
        New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
        Copy-Item -LiteralPath $resolvedTarget -Destination (Join-Path $backupDirectory (Split-Path -Leaf $resolvedTarget)) -Recurse
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
}

& (Join-Path $PSScriptRoot 'prepare-local-prototype.ps1') -SkipBuild | Out-Null
$branch = 'prototype-local'
if (Test-Path -LiteralPath $paths.ConfigPath) {
    try {
        $savedConfig = Get-Content -LiteralPath $paths.ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ([string]$savedConfig.Workspace -match '^[A-Za-z0-9._-]+$') {
            $branch = [string]$savedConfig.Workspace
        }
    }
    catch { $branch = 'prototype-local' }
}
& (Join-Path $PSScriptRoot 'local-prototype-git.ps1') -Action Prepare -Branch $branch | Out-Null
[pscustomobject]@{
    Status = 'reset'
    Message = 'Test workspaces, collaborative server data, and merge-base snapshots were reset.'
    BackupDirectory = $backupDirectory
}
