param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-prototype-common.ps1')
$paths = Get-LocalPrototypePaths
New-Item -ItemType Directory -Path $paths.RuntimeRoot, $paths.LogsDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $paths.ProjectRoot 'node_modules'))) {
    throw 'Node dependencies are missing. Run npm ci once in the project directory.'
}

if (-not $SkipBuild) {
    $buildLog = Join-Path $paths.LogsDirectory 'prepare-build.log'
    Push-Location $paths.ProjectRoot
    try {
        & npm.cmd run build:review *> $buildLog
        if ($LASTEXITCODE -ne 0) { throw "Review build failed. See $buildLog" }
    }
    finally { Pop-Location }
}

if (-not (Test-Path -LiteralPath $paths.ReviewHost -PathType Leaf)) {
    throw "Review host was not found: $($paths.ReviewHost)"
}

[pscustomobject]@{
    Version = '0.8.8F10'
    ReviewHost = $paths.ReviewHost
    WorkspaceA = $paths.WorkspaceA
    WorkspaceB = $paths.WorkspaceB
}
