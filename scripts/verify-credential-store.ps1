param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-store.ps1')
$firstOrigin = Get-EawHubServerOrigin -Server 'wss://Example.COM/path?ignored=yes'
$secondOrigin = Get-EawHubServerOrigin -Server 'https://example.com/'
if ($firstOrigin -cne 'wss://example.com:443' -or $secondOrigin -cne $firstOrigin) {
    throw 'Server origin normalization is not stable across HTTPS and WSS forms.'
}
$firstServerTarget = Get-EawHubCredentialTarget -Server 'wss://example.com' -Kind 'AgentToken'
$secondServerTarget = Get-EawHubCredentialTarget -Server 'wss://other.example.com' -Kind 'AgentToken'
if ($firstServerTarget -ceq $secondServerTarget) { throw 'Different server origins share a credential target.' }
$target = 'EaWLocalisationHub.AutomatedTest.' + [Guid]::NewGuid().ToString('N')
$randomBytes = [byte[]]::new(32)
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
$secret = [Convert]::ToBase64String($randomBytes)
try {
    Set-EawHubCredential -Target $target -UserName 'Automated test' -Secret $secret
    $stored = Get-EawHubCredential -Target $target
    if (-not $stored -or $stored.UserName -ne 'Automated test' -or $stored.Secret -cne $secret) {
        throw 'Credential Manager did not return the stored value.'
    }
}
finally {
    Remove-EawHubCredential -Target $target
}
if ($null -ne (Get-EawHubCredential -Target $target)) {
    throw 'Credential Manager test value remained after deletion.'
}
Write-Output '[credential-smoke] write, read, and delete passed'
