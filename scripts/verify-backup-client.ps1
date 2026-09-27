$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'credential-store.ps1')

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("EaWHubBackupTest-" + [Guid]::NewGuid().ToString('N'))
$resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$resolvedTest = [System.IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTest.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to create backup test files outside the temporary directory.'
}

$credentialTarget = 'EaWLocalisationHub.BackupPassphrase.Test.' + [Guid]::NewGuid().ToString('N')
$serverProcess = $null
$credentialCreated = $false
try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $readyFile = Join-Path $testRoot 'server-port.txt'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $fixture = Join-Path $projectRoot 'test\fixtures\backup-http-server.mjs'
    $arguments = '"' + $fixture + '" "' + $readyFile + '"'
    $serverProcess = Start-Process -FilePath $node -ArgumentList $arguments `
        -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardError (Join-Path $testRoot 'server-error.log')
    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $readyFile); $attempt++) {
        if ($serverProcess.HasExited) { throw 'Backup test server exited before opening its port.' }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $readyFile)) { throw 'Backup test server did not start.' }
    $port = [int](Get-Content -LiteralPath $readyFile -Raw -Encoding ascii)
    $server = "http://127.0.0.1:$port"

    Set-EawHubCredential -Target $credentialTarget -UserName 'EaW backup test' -Secret 'correct horse battery staple'
    $credentialCreated = $true
    $destination = Join-Path $testRoot 'backups'
    $result = & (Join-Path $PSScriptRoot 'backup-server.ps1') -Server $server `
        -Destination $destination -AdminToken 'eaw_backup_test' -PassphraseCredentialTarget $credentialTarget
    if ($result.Bytes -le 55 -or -not (Test-Path -LiteralPath $result.Backup -PathType Leaf)) {
        throw 'Backup script did not create an encrypted file.'
    }

    $unauthorizedRejected = $false
    try {
        [void](& (Join-Path $PSScriptRoot 'backup-server.ps1') -Server $server `
            -Destination $destination -AdminToken 'wrong_test_token' -PassphraseCredentialTarget $credentialTarget)
    } catch {
        $unauthorizedRejected = $_.Exception.Message -match '401'
    }
    if (-not $unauthorizedRejected) { throw 'Backup script did not report the backup-token authorization failure.' }

    $plainErrorReported = $false
    try {
        [void](& (Join-Path $PSScriptRoot 'backup-server.ps1') -Server $server `
            -Destination $destination -AdminToken 'eaw_backup_plain_error' -PassphraseCredentialTarget $credentialTarget)
    } catch {
        $plainErrorReported = $_.Exception.Message -match '503 Service Unavailable: Backup upstream unavailable'
    }
    if (-not $plainErrorReported) { throw 'Backup script did not report the plain-text HTTP error.' }
    Write-Output '[backup-client-integration] encrypted local backup and 401/503 diagnostics passed'
} finally {
    if ($credentialCreated) { Remove-EawHubCredential -Target $credentialTarget }
    if ($serverProcess) {
        try {
            $serverProcess.Refresh()
            if (-not $serverProcess.HasExited -and
                [string]::Equals($serverProcess.Path, $node, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
                $serverProcess.WaitForExit(3000) | Out-Null
            }
        } catch {}
    }
    if (Test-Path -LiteralPath $resolvedTest) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force
    }
}
