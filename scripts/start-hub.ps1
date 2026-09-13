param([string]$FilePath)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EaWLocalisationHub'
$sessionPath = Join-Path $stateRoot 'review-session.json'

function Get-LiveSession {
    if (-not (Test-Path -LiteralPath $sessionPath -PathType Leaf)) { return $null }
    try {
        $session = Get-Content -LiteralPath $sessionPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($session.schema -eq 1 -and $session.origin -match '^http://127\.0\.0\.1:\d+$' `
            -and -not [string]::IsNullOrWhiteSpace([string]$session.token) `
            -and (Get-Process -Id ([int]$session.pid) -ErrorAction SilentlyContinue)) { return $session }
    } catch { return $null }
    return $null
}

$session = Get-LiveSession
if (-not $session) {
    Start-Process -FilePath (Join-Path $projectRoot 'Launch EaW Hub Agent.cmd') `
        -WorkingDirectory $projectRoot
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 250
        $session = Get-LiveSession
    } while (-not $session -and [DateTime]::UtcNow -lt $deadline)
    if (-not $session) { throw 'Desktop Agent did not start in time. Open Agent to inspect its setup error.' }
}

$ticket = ''
if ([string]::IsNullOrWhiteSpace($FilePath)) {
    $lastPath = Join-Path $stateRoot 'last-review.json'
    if (Test-Path -LiteralPath $lastPath -PathType Leaf) {
        try {
            $last = Get-Content -LiteralPath $lastPath -Raw -Encoding utf8 | ConvertFrom-Json
            $root = [System.IO.Path]::GetFullPath([string]$session.repository).TrimEnd('\') + '\'
            $candidate = [System.IO.Path]::GetFullPath([string]$last.path)
            if ($last.schema -eq 1 -and $candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) `
                -and $candidate -match '\.ya?ml$' -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                $FilePath = $candidate
                $ticket = [string]$last.ticket
            }
        } catch { $FilePath = '' }
    }
}

& (Join-Path $PSScriptRoot 'start-review.ps1') -FilePath $FilePath -Ticket $ticket
