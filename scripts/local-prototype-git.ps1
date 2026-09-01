param(
    [ValidateSet('Prepare', 'Publish', 'SyncA', 'SyncB', 'Status')]
    [string]$Action = 'Status',
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Branch = 'prototype-local'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-prototype-common.ps1')
$paths = Get-LocalPrototypePaths

function Invoke-LabGit {
    param([string]$Directory, [string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & git.exe -C $Directory @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw "Git failed in $Directory`: $($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

function Assert-LabPath {
    param([string]$Target)
    $runtime = [System.IO.Path]::GetFullPath($paths.RuntimeRoot).TrimEnd('\') + '\'
    $resolved = [System.IO.Path]::GetFullPath($Target)
    if (-not $resolved.StartsWith($runtime, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a Git path outside the local prototype runtime: $resolved"
    }
}

function Initialize-Origin {
    Assert-LabPath $paths.GitOriginDirectory
    Assert-LabPath $paths.GitPublisherDirectory
    if (-not (Test-Path -LiteralPath (Join-Path $paths.GitPublisherDirectory '.git'))) {
        if (Test-Path -LiteralPath $paths.GitPublisherDirectory) {
            Remove-Item -LiteralPath $paths.GitPublisherDirectory -Recurse -Force
        }
        Copy-Item -LiteralPath $paths.FixtureDirectory -Destination $paths.GitPublisherDirectory -Recurse
        Invoke-LabGit $paths.GitPublisherDirectory @('init', '-b', $Branch) | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('config', 'user.name', 'EaW Hub Local Lab') | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('config', 'user.email', 'local-lab@invalid') | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('add', '--all') | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('commit', '-m', 'Local lab initial state') | Out-Null
    }
    $publisherHasCommit = $true
    try { Invoke-LabGit $paths.GitPublisherDirectory @('rev-parse', '--verify', 'HEAD') | Out-Null }
    catch { $publisherHasCommit = $false }
    if (-not $publisherHasCommit) {
        Invoke-LabGit $paths.GitPublisherDirectory @('config', 'user.name', 'EaW Hub Local Lab') | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('config', 'user.email', 'local-lab@invalid') | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('add', '--all') | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('commit', '-m', 'Local lab initial state') | Out-Null
    }
    if (-not (Test-Path -LiteralPath (Join-Path $paths.GitOriginDirectory 'HEAD'))) {
        if (Test-Path -LiteralPath $paths.GitOriginDirectory) {
            Remove-Item -LiteralPath $paths.GitOriginDirectory -Recurse -Force
        }
        New-Item -ItemType Directory -Path $paths.GitOriginDirectory -Force | Out-Null
        Invoke-LabGit $paths.GitOriginDirectory @('init', '--bare') | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('remote', 'add', 'origin', $paths.GitOriginDirectory) | Out-Null
        Invoke-LabGit $paths.GitPublisherDirectory @('push', '-u', 'origin', $Branch) | Out-Null
    }
    $remotes = @(Invoke-LabGit $paths.GitPublisherDirectory @('remote') -split '\r?\n')
    if ($remotes -notcontains 'origin') {
        Invoke-LabGit $paths.GitPublisherDirectory @('remote', 'add', 'origin', $paths.GitOriginDirectory) | Out-Null
    }
    $remote = Invoke-LabGit $paths.GitPublisherDirectory @('remote', 'get-url', 'origin')
    if (-not [string]::Equals([System.IO.Path]::GetFullPath($remote), [System.IO.Path]::GetFullPath($paths.GitOriginDirectory), [System.StringComparison]::OrdinalIgnoreCase)) {
        Invoke-LabGit $paths.GitPublisherDirectory @('remote', 'set-url', 'origin', $paths.GitOriginDirectory) | Out-Null
    }
    $branchExists = $true
    try { Invoke-LabGit $paths.GitOriginDirectory @('show-ref', '--verify', '--quiet', "refs/heads/$Branch") | Out-Null }
    catch { $branchExists = $false }
    if (-not $branchExists) {
        $localBranches = @(Invoke-LabGit $paths.GitPublisherDirectory @('branch', '--format=%(refname:short)') -split '\r?\n')
        if ($localBranches -notcontains $Branch) {
            Invoke-LabGit $paths.GitPublisherDirectory @('branch', $Branch) | Out-Null
        }
        Invoke-LabGit $paths.GitPublisherDirectory @('push', '-u', 'origin', $Branch) | Out-Null
    }
    Invoke-LabGit $paths.GitPublisherDirectory @('switch', $Branch) | Out-Null
}

function Initialize-Workspace {
    param([string]$Directory)
    Assert-LabPath $Directory
    if (-not (Test-Path -LiteralPath (Join-Path $Directory '.git'))) {
        if (Test-Path -LiteralPath $Directory) {
            Remove-Item -LiteralPath $Directory -Recurse -Force
        }
        Invoke-LabGit $paths.RuntimeRoot @('clone', '--branch', $Branch, '--single-branch', $paths.GitOriginDirectory, $Directory) | Out-Null
    }
    $current = Invoke-LabGit $Directory @('branch', '--show-current')
    if ($current -ne $Branch) {
        throw "Test workspace is on branch '$current', expected '$Branch'. Reset the test data before changing the laboratory branch."
    }
}

if ($Action -eq 'Prepare') {
    Initialize-Origin
    Initialize-Workspace $paths.WorkspaceA
    Initialize-Workspace $paths.WorkspaceB
} elseif ($Action -eq 'Publish') {
    Initialize-Origin
    $probeDirectory = Join-Path $paths.GitPublisherDirectory 'localisation\replace'
    New-Item -ItemType Directory -Path $probeDirectory -Force | Out-Null
    $probePath = Join-Path $probeDirectory 'prototype_git_probe_l_russian.yml'
    $sequence = 1
    if (Test-Path -LiteralPath $probePath) {
        $match = [regex]::Match((Get-Content -LiteralPath $probePath -Raw -Encoding utf8), 'prototype_git_probe:0 "(\d+)"')
        if ($match.Success) { $sequence = [int]$match.Groups[1].Value + 1 }
    }
    [System.IO.File]::WriteAllText($probePath, "l_russian:`n prototype_git_probe:0 `"$sequence`"`n", [System.Text.UTF8Encoding]::new($true))
    Invoke-LabGit $paths.GitPublisherDirectory @('add', '--', 'localisation/replace/prototype_git_probe_l_russian.yml') | Out-Null
    Invoke-LabGit $paths.GitPublisherDirectory @('commit', '-m', "Local lab canonical update $sequence") | Out-Null
    Invoke-LabGit $paths.GitPublisherDirectory @('push', 'origin', $Branch) | Out-Null
} elseif ($Action -eq 'SyncA' -or $Action -eq 'SyncB') {
    $workspace = if ($Action -eq 'SyncA') { $paths.WorkspaceA } else { $paths.WorkspaceB }
    Initialize-Workspace $workspace
    Invoke-LabGit $workspace @('pull', '--ff-only', 'origin', $Branch) | Out-Null
}

$originHead = if (Test-Path -LiteralPath (Join-Path $paths.GitOriginDirectory 'HEAD')) {
    Invoke-LabGit $paths.GitOriginDirectory @('rev-parse', "refs/heads/$Branch")
} else { '' }
[pscustomobject]@{
    Action = $Action
    Branch = $Branch
    OriginCommit = $originHead
    AgentACommit = if (Test-Path -LiteralPath (Join-Path $paths.WorkspaceA '.git')) { Invoke-LabGit $paths.WorkspaceA @('rev-parse', 'HEAD') } else { '' }
    AgentBCommit = if (Test-Path -LiteralPath (Join-Path $paths.WorkspaceB '.git')) { Invoke-LabGit $paths.WorkspaceB @('rev-parse', 'HEAD') } else { '' }
}
