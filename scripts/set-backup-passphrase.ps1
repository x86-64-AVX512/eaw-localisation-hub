param([string]$CredentialTarget = 'EaWLocalisationHub.BackupPassphrase')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-store.ps1')
$first = Read-Host 'Введите пароль резервных копий (минимум 12 символов)' -AsSecureString
$second = Read-Host 'Повторите пароль' -AsSecureString
function Read-PlainText([Security.SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
$firstText = Read-PlainText $first
$secondText = Read-PlainText $second
try {
    if ($firstText.Length -lt 12) { throw 'Пароль должен содержать минимум 12 символов.' }
    if ($firstText -cne $secondText) { throw 'Введённые пароли не совпадают.' }
    Set-EawHubCredential -Target $CredentialTarget -UserName 'EaW Hub backup encryption' -Secret $firstText
    Write-Output "Backup passphrase saved in Windows Credential Manager: $CredentialTarget"
}
finally {
    $firstText = $null
    $secondText = $null
}
