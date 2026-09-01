$script:LocalPrototypeProjectRoot = Split-Path -Parent $PSScriptRoot

function Get-LocalPrototypePaths {
    $runtimeRoot = Join-Path $script:LocalPrototypeProjectRoot '.tools\local-prototype'
    [pscustomobject]@{
        ProjectRoot = $script:LocalPrototypeProjectRoot
        RuntimeRoot = $runtimeRoot
        StatePath = Join-Path $runtimeRoot 'state.json'
        ConfigPath = Join-Path $runtimeRoot 'config.json'
        LogsDirectory = Join-Path $runtimeRoot 'logs'
        ServerDataDirectory = Join-Path $runtimeRoot 'server-data'
        ProtectedServerDataDirectory = Join-Path $runtimeRoot 'protected-server-data'
        PortableA = Join-Path $runtimeRoot 'notepad-a'
        PortableB = Join-Path $runtimeRoot 'notepad-b'
        WorkspaceA = Join-Path $runtimeRoot 'workspace-a'
        WorkspaceB = Join-Path $runtimeRoot 'workspace-b'
        AgentStateA = Join-Path $runtimeRoot 'agent-state-a'
        AgentStateB = Join-Path $runtimeRoot 'agent-state-b'
        GitOriginDirectory = Join-Path $runtimeRoot 'git-origin.git'
        GitPublisherDirectory = Join-Path $runtimeRoot 'git-publisher'
        FixtureDirectory = Join-Path $script:LocalPrototypeProjectRoot 'test\fixtures\repo'
        PluginBuildDirectory = Join-Path $script:LocalPrototypeProjectRoot 'dist\EawLocalisationHub'
    }
}

function ConvertTo-ProcessArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw 'Process arguments cannot contain quotes or line breaks.'
    }
    return '"' + $Value + '"'
}

function Write-JsonUtf8 {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $json = $Value | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-FreeLocalPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Start-HiddenNodeProcess {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$StandardOutput,
        [Parameter(Mandatory = $true)][string]$StandardError
    )
    $node = (Get-Command node -ErrorAction Stop).Source
    $argumentLine = ($Arguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join ' '
    Start-Process -FilePath $node `
        -ArgumentList $argumentLine `
        -WorkingDirectory $script:LocalPrototypeProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StandardOutput `
        -RedirectStandardError $StandardError `
        -PassThru
}

function Wait-ForLogText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [int]$TimeoutSeconds = 15,
        [System.Diagnostics.Process]$Process
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $Path) {
            $content = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
            if ($content -match $Pattern) { return $true }
        }
        if ($Process -and $Process.HasExited) {
            throw "Process $($Process.Id) exited before writing '$Pattern'."
        }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function Test-OwnedProcess {
    param(
        [Parameter(Mandatory = $true)][int]$Id,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
        [string]$CommandMarker
    )
    $process = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    try {
        $executableMatches = [string]::Equals(
            [System.IO.Path]::GetFullPath($process.Path),
            [System.IO.Path]::GetFullPath($ExpectedExecutable),
            [System.StringComparison]::OrdinalIgnoreCase)
        if (-not $executableMatches) { return $false }
        if ($CommandMarker) {
            $instance = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction Stop
            return ([string]$instance.CommandLine).IndexOf(
                $CommandMarker,
                [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        return $true
    }
    catch {
        return $false
    }
}
