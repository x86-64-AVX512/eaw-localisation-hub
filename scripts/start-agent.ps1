param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,
    [Parameter(Mandatory = $true)]
    [string]$User,
    [string]$Server = 'ws://127.0.0.1:3210',
    [string]$Workspace,
    [string]$StateDirectory,
    [string]$TokenFile,
    [string]$Color = '#6aa9ff'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$arguments = @(
    '.\apps\agent\src\main.mjs',
    '--repo', $Repo,
    '--user', $User,
    '--server', $Server,
    '--color', $Color
)
if ($Workspace) {
    $arguments += @('--workspace', $Workspace)
}
if ($StateDirectory) {
    $arguments += @('--state', $StateDirectory)
}
if ($TokenFile) {
    $arguments += @('--token-file', $TokenFile)
}

Push-Location $projectRoot
try {
    & node @arguments
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
