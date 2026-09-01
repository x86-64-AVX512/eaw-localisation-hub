param([string]$FilePath)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localData = [Environment]::GetFolderPath('LocalApplicationData')
$stateRoot = Join-Path $localData 'EaWLocalisationHub'
$sessionPath = Join-Path $stateRoot 'review-session.json'
if (-not (Test-Path -LiteralPath $sessionPath -PathType Leaf)) {
    throw 'Desktop Agent is not running: the local Review session was not found.'
}
$session = Get-Content -LiteralPath $sessionPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($session.schema -ne 1 -or $session.origin -notmatch '^http://127\.0\.0\.1:\d+$' `
    -or [string]::IsNullOrWhiteSpace([string]$session.token)) {
    throw 'The local Review session is invalid.'
}
if (-not (Get-Process -Id ([int]$session.pid) -ErrorAction SilentlyContinue)) {
    throw 'The Desktop Agent for this Review session has stopped.'
}
if ([string]::IsNullOrWhiteSpace($FilePath)) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = [System.Windows.Forms.OpenFileDialog]::new()
    $dialog.Title = 'Open localisation in EaW Hub Review'
    $dialog.Filter = 'Localisation files (*.yml)|*.yml'
    $dialog.InitialDirectory = Join-Path ([string]$session.repository) 'localisation\russian'
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $FilePath = $dialog.FileName
}
$resolvedFile = [System.IO.Path]::GetFullPath($FilePath)
$hostCandidates = @(
    (Join-Path $projectRoot 'dist\EawReview\EaWReview.exe'),
    (Join-Path (Split-Path -Parent $PSScriptRoot) 'review\EaWReview.exe')
)
$hostPath = $hostCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $hostPath) { throw 'EaWReview.exe was not found. Build or reinstall the client first.' }
$url = ([string]$session.origin) + '/#token=' `
    + [Uri]::EscapeDataString([string]$session.token) + '&path=' + [Uri]::EscapeDataString($resolvedFile)
Start-Process -FilePath $hostPath -ArgumentList @($url) -WorkingDirectory (Split-Path -Parent $hostPath)
