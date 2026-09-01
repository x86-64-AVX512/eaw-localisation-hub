param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,
    [Parameter(Mandatory = $true)]
    [string]$User,
    [string]$Server = 'ws://127.0.0.1:3210',
    [string]$Workspace,
    [string]$StateDirectory,
    [string]$TokenFile,
    [string]$Color = '#6aa9ff',
    [string]$Pipe = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'credential-store.ps1')
$arguments = @(
    '.\apps\agent\src\main.mjs',
    '--repo', $Repo,
    '--user', $User,
    '--server', $Server,
    '--color', $Color
)
if ($Pipe) { $arguments += @('--pipe', $Pipe) }
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
$previousIpcSecret = $env:EAW_HUB_IPC_SECRET
try {
    $env:EAW_HUB_IPC_SECRET = Get-OrCreate-EawHubIpcSecret
    & node @arguments
    exit $LASTEXITCODE
}
finally {
    if ($null -eq $previousIpcSecret) { Remove-Item Env:EAW_HUB_IPC_SECRET -ErrorAction SilentlyContinue }
    else { $env:EAW_HUB_IPC_SECRET = $previousIpcSecret }
    Pop-Location
}
