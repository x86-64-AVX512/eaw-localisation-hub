param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$Destination = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'EaW Hub Backups'),
    [ValidateRange(1, 365)][int]$Keep = 14,
    [string]$CredentialTarget = '',
    [string]$AdminToken = '',
    [string]$PassphraseCredentialTarget = 'EaWLocalisationHub.BackupPassphrase'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-store.ps1')
if ([string]::IsNullOrWhiteSpace($AdminToken)) {
    if ([string]::IsNullOrWhiteSpace($CredentialTarget)) {
        $CredentialTarget = Get-EawHubCredentialTarget -Server $Server -Kind 'BackupToken'
    }
    $credential = Get-EawHubCredential -Target $CredentialTarget
    if (-not $credential) { throw "Backup token was not found in Windows Credential Manager: $CredentialTarget" }
    $AdminToken = $credential.Secret
}
$passphrase = Get-EawHubCredential -Target $PassphraseCredentialTarget
if (-not $passphrase) {
    throw "Backup passphrase was not found. Run scripts\set-backup-passphrase.ps1 first."
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$target = Join-Path $Destination ("eaw-hub-" + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.eawhub.enc')
$projectRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $projectRoot 'node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
$oldAdmin = $env:EAW_HUB_ADMIN_TOKEN
$oldPassphrase = $env:EAW_HUB_BACKUP_PASSPHRASE
try {
    $env:EAW_HUB_ADMIN_TOKEN = $AdminToken
    $env:EAW_HUB_BACKUP_PASSPHRASE = $passphrase.Secret
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $commandOutput = @(& $node (Join-Path $PSScriptRoot 'manage-server.mjs') `
            backup --server $Server --output $target 2>&1)
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousErrorAction }
    if ($exitCode -ne 0) {
        $reason = @($commandOutput | ForEach-Object { [string]$_ } |
            Where-Object { $_ -match '^(?:Error|TypeError):\s+' } | Select-Object -First 1)
        $detail = if ($reason.Count) { $reason[0].Trim() } else { 'Подробности не получены от программы резервного копирования.' }
        throw "Не удалось создать копию (код $exitCode): $detail"
    }
}
finally {
    if ($null -eq $oldAdmin) { Remove-Item Env:EAW_HUB_ADMIN_TOKEN -ErrorAction SilentlyContinue } else { $env:EAW_HUB_ADMIN_TOKEN = $oldAdmin }
    if ($null -eq $oldPassphrase) { Remove-Item Env:EAW_HUB_BACKUP_PASSPHRASE -ErrorAction SilentlyContinue } else { $env:EAW_HUB_BACKUP_PASSPHRASE = $oldPassphrase }
}
$backupFile = Get-Item -LiteralPath $target -ErrorAction Stop
if ($backupFile.Length -le 55) { throw 'Созданный файл резервной копии слишком мал.' }
$stream = [System.IO.File]::OpenRead($target)
try {
    $header = [byte[]]::new(11)
    if ($stream.Read($header, 0, $header.Length) -ne $header.Length -or
        [System.Text.Encoding]::ASCII.GetString($header) -cne "EAWHUBENC1`0") {
        throw 'Созданный файл не имеет ожидаемого зашифрованного формата.'
    }
} finally { $stream.Dispose() }
$backups = @(Get-ChildItem -LiteralPath $Destination -Filter 'eaw-hub-*.eawhub.enc' -File | Sort-Object LastWriteTimeUtc -Descending)
foreach ($old in @($backups | Select-Object -Skip $Keep)) {
    Remove-Item -LiteralPath $old.FullName -Force
}
[pscustomobject]@{ Backup = $target; Bytes = $backupFile.Length; Retained = [Math]::Min($backups.Count, $Keep) }
