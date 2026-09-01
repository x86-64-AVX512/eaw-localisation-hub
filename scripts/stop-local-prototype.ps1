param([switch]$KeepEditors)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-prototype-common.ps1')
$paths = Get-LocalPrototypePaths
if (-not (Test-Path -LiteralPath $paths.StatePath)) {
    [pscustomobject]@{ Status = 'stopped'; Message = 'No local prototype session is recorded.' }
    exit 0
}

$state = Get-Content -LiteralPath $paths.StatePath -Raw -Encoding utf8 | ConvertFrom-Json
$processes = @($state.Processes)
if (-not $KeepEditors) {
    foreach ($entry in $processes | Where-Object { $_.Role -like 'notepad-*' }) {
        if (Test-OwnedProcess -Id ([int]$entry.Id) -ExpectedExecutable ([string]$entry.Executable) -CommandMarker ([string]$entry.CommandMarker)) {
            $process = Get-Process -Id ([int]$entry.Id)
            [void]$process.CloseMainWindow()
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $openEditors = @($processes | Where-Object { $_.Role -like 'notepad-*' } | Where-Object {
            Test-OwnedProcess -Id ([int]$_.Id) -ExpectedExecutable ([string]$_.Executable) -CommandMarker ([string]$_.CommandMarker)
        })
        if ($openEditors.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($openEditors.Count -gt 0) {
        throw 'Notepad++ is waiting for unsaved-file confirmation. Save or discard the changes, then press Stop again.'
    }
}

Start-Sleep -Milliseconds 350
foreach ($entry in $processes | Where-Object { $_.Role -like 'agent-*' }) {
    if (Test-OwnedProcess -Id ([int]$entry.Id) -ExpectedExecutable ([string]$entry.Executable) -CommandMarker ([string]$entry.CommandMarker)) {
        Stop-Process -Id ([int]$entry.Id) -Force
    }
}
foreach ($entry in $processes | Where-Object { $_.Role -eq 'server' }) {
    if (Test-OwnedProcess -Id ([int]$entry.Id) -ExpectedExecutable ([string]$entry.Executable) -CommandMarker ([string]$entry.CommandMarker)) {
        Stop-Process -Id ([int]$entry.Id) -Force
    }
}

Remove-Item -LiteralPath $paths.StatePath -Force
[pscustomobject]@{ Status = 'stopped'; Message = 'Local prototype services were stopped.' }
