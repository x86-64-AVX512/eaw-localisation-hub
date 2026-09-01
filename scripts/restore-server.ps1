param(
    [Parameter(Mandatory = $true)][string]$Backup,
    [Parameter(Mandatory = $true)][string]$DataDirectory,
    [string]$PassphraseCredentialTarget = 'EaWLocalisationHub.BackupPassphrase',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $projectRoot 'node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
. (Join-Path $PSScriptRoot 'credential-store.ps1')
$passphrase = Get-EawHubCredential -Target $PassphraseCredentialTarget
if (-not $passphrase) { throw "Backup passphrase was not found: $PassphraseCredentialTarget" }
$arguments = @(
    (Join-Path $projectRoot 'apps\server\src\restore.mjs'),
    '--backup', [System.IO.Path]::GetFullPath($Backup),
    '--data', [System.IO.Path]::GetFullPath($DataDirectory)
)
if ($Force) { $arguments += '--force' }
$oldPassphrase = $env:EAW_HUB_BACKUP_PASSPHRASE
try {
    $env:EAW_HUB_BACKUP_PASSPHRASE = $passphrase.Secret
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw "Restore failed with exit code $LASTEXITCODE." }
}
finally {
    if ($null -eq $oldPassphrase) { Remove-Item Env:EAW_HUB_BACKUP_PASSPHRASE -ErrorAction SilentlyContinue }
    else { $env:EAW_HUB_BACKUP_PASSPHRASE = $oldPassphrase }
}
