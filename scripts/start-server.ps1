param(
    [string]$ListenAddress = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$Port = 3210,
    [string]$DataDirectory,
    [ValidateSet('required', 'disabled')]
    [string]$Auth = 'required'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $DataDirectory) {
    $DataDirectory = Join-Path $projectRoot 'data\prototype-server'
}

Push-Location $projectRoot
try {
    & node '.\apps\server\src\main.mjs' --host $ListenAddress --port $Port --data $DataDirectory --auth $Auth
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
