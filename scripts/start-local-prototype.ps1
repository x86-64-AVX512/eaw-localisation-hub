param(
    [ValidateNotNullOrEmpty()]
    [string]$User = [Environment]::UserName,
    [ValidateNotNullOrEmpty()]
    [string]$SecondUser = 'Test Translator',
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Workspace = 'prototype-local',
    [switch]$ProtectedAuth,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-prototype-common.ps1')
$paths = Get-LocalPrototypePaths

if (Test-Path -LiteralPath $paths.StatePath) {
    $existing = Get-Content -LiteralPath $paths.StatePath -Raw -Encoding utf8 | ConvertFrom-Json
    $running = @($existing.Processes) | Where-Object {
        Test-OwnedProcess -Id ([int]$_.Id) -ExpectedExecutable ([string]$_.Executable) -CommandMarker ([string]$_.CommandMarker)
    }
    if ($running.Count -gt 0) {
        throw 'The local prototype is already running. Stop it before starting another session.'
    }
}

& (Join-Path $PSScriptRoot 'prepare-local-prototype.ps1') -SkipBuild:$SkipBuild | Out-Null
& (Join-Path $PSScriptRoot 'local-prototype-git.ps1') -Action Prepare -Branch $Workspace | Out-Null
New-Item -ItemType Directory -Path $paths.LogsDirectory -Force | Out-Null

$preflightFileA = Join-Path $paths.WorkspaceA 'localisation\russian\prototype_l_russian.yml'
$preflightFileB = Join-Path $paths.WorkspaceB 'localisation\russian\prototype_l_russian.yml'
$hashA = (Get-FileHash -LiteralPath $preflightFileA -Algorithm SHA256).Hash
$hashB = (Get-FileHash -LiteralPath $preflightFileB -Algorithm SHA256).Hash
if ($hashA -ne $hashB) {
    throw 'The two test files differ after the previous run. In the launcher, click "Reset test data" before starting a new laboratory session.'
}

$sessionId = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$port = Get-FreeLocalPort
$serverUrl = "ws://127.0.0.1:$port"
$serverOutput = Join-Path $paths.LogsDirectory "server-$sessionId.out.log"
$serverError = Join-Path $paths.LogsDirectory "server-$sessionId.err.log"
$agentAOutput = Join-Path $paths.LogsDirectory "agent-a-$sessionId.out.log"
$agentAError = Join-Path $paths.LogsDirectory "agent-a-$sessionId.err.log"
$agentBOutput = Join-Path $paths.LogsDirectory "agent-b-$sessionId.out.log"
$agentBError = Join-Path $paths.LogsDirectory "agent-b-$sessionId.err.log"
$startedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$serverDataDirectory = if ($ProtectedAuth) { $paths.ProtectedServerDataDirectory } else { $paths.ServerDataDirectory }

try {
    if ($ProtectedAuth) {
        $runtimeRoot = [System.IO.Path]::GetFullPath($paths.RuntimeRoot).TrimEnd('\') + '\'
        $protectedData = [System.IO.Path]::GetFullPath($paths.ProtectedServerDataDirectory)
        if (-not $protectedData.StartsWith($runtimeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to recreate protected test data outside the local prototype runtime: $protectedData"
        }
        if (Test-Path -LiteralPath $protectedData) {
            Remove-Item -LiteralPath $protectedData -Recurse -Force
        }
    }
    $previousCanonicalRepository = $env:EAW_HUB_CANONICAL_REPOSITORY
    $previousGithubRepository = $env:EAW_HUB_GITHUB_REPOSITORY
    $previousGitRefresh = $env:EAW_HUB_GIT_REFRESH_MILLISECONDS
    try {
        $env:EAW_HUB_CANONICAL_REPOSITORY = ([System.Uri]::new($paths.GitOriginDirectory)).AbsoluteUri
        Remove-Item Env:EAW_HUB_GITHUB_REPOSITORY -ErrorAction SilentlyContinue
        $env:EAW_HUB_GIT_REFRESH_MILLISECONDS = '1000'
        $server = Start-HiddenNodeProcess -Arguments @(
            'apps/server/src/main.mjs', '--host', '127.0.0.1', '--port', [string]$port,
            '--data', $serverDataDirectory, '--auth', $(if ($ProtectedAuth) { 'required' } else { 'disabled' })
        ) -StandardOutput $serverOutput -StandardError $serverError
    }
    finally {
        if ($null -eq $previousCanonicalRepository) { Remove-Item Env:EAW_HUB_CANONICAL_REPOSITORY -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_CANONICAL_REPOSITORY = $previousCanonicalRepository }
        if ($null -eq $previousGithubRepository) { Remove-Item Env:EAW_HUB_GITHUB_REPOSITORY -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_GITHUB_REPOSITORY = $previousGithubRepository }
        if ($null -eq $previousGitRefresh) { Remove-Item Env:EAW_HUB_GIT_REFRESH_MILLISECONDS -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_GIT_REFRESH_MILLISECONDS = $previousGitRefresh }
    }
    $startedProcesses.Add($server)
    if (-not (Wait-ForLogText -Path $serverOutput -Pattern 'listening on' -Process $server)) {
        throw "Server did not become ready. See $serverOutput"
    }

    $tokenA = $null
    $tokenB = $null
    if ($ProtectedAuth) {
        $bootstrapPath = Join-Path $serverDataDirectory 'bootstrap-invite.txt'
        if (-not (Test-Path -LiteralPath $bootstrapPath)) {
            throw 'Protected server did not create its bootstrap invitation.'
        }
        $bootstrapCode = (Get-Content -LiteralPath $bootstrapPath -Raw -Encoding utf8).Trim()
        $passwordA = [Guid]::NewGuid().ToString('N') + '-Lab-A!'
        $passwordB = [Guid]::NewGuid().ToString('N') + '-Lab-B!'
        $httpBase = "http://127.0.0.1:$port"
        $admin = Invoke-RestMethod -Method Post -Uri "$httpBase/api/auth/redeem" -ContentType 'application/json' -Body (@{
            inviteCode = $bootstrapCode
            displayName = $User
            password = $passwordA
        } | ConvertTo-Json -Compress)
        $invite = Invoke-RestMethod -Method Post -Uri "$httpBase/api/admin/invites" -ContentType 'application/json' -Headers @{
            Authorization = "Bearer $($admin.token)"
        } -Body (@{
            roles = @('translator', 'translation-editor')
            maxUses = 1
            expiresInHours = 1
        } | ConvertTo-Json -Compress)
        $peer = Invoke-RestMethod -Method Post -Uri "$httpBase/api/auth/redeem" -ContentType 'application/json' -Body (@{
            inviteCode = $invite.code
            displayName = $SecondUser
            password = $passwordB
        } | ConvertTo-Json -Compress)
        $tokenA = [string]$admin.token
        $tokenB = [string]$peer.token
        $bootstrapCode = $null
        $passwordA = $null
        $passwordB = $null
        $admin = $null
        $invite = $null
        $peer = $null
    }

    $pipeA = "eaw-hub-$sessionId-a"
    $pipeB = "eaw-hub-$sessionId-b"
    $ipcSecretA = [Guid]::NewGuid().ToString('N')
    $ipcSecretB = [Guid]::NewGuid().ToString('N')
    $previousToken = $env:EAW_HUB_TOKEN
    $previousIpcSecret = $env:EAW_HUB_IPC_SECRET
    try {
        if ($ProtectedAuth) { $env:EAW_HUB_TOKEN = $tokenA }
        else { Remove-Item Env:EAW_HUB_TOKEN -ErrorAction SilentlyContinue }
        $env:EAW_HUB_IPC_SECRET = $ipcSecretA
        $agentA = Start-HiddenNodeProcess -Arguments @(
            'apps/agent/src/main.mjs', '--repo', $paths.WorkspaceA, '--workspace', $Workspace,
            '--pipe', $pipeA, '--user', $User, '--color', '#ff6677', '--server', $serverUrl,
            '--state', $paths.AgentStateA
        ) -StandardOutput $agentAOutput -StandardError $agentAError
        if ($ProtectedAuth) { $env:EAW_HUB_TOKEN = $tokenB }
        $env:EAW_HUB_IPC_SECRET = $ipcSecretB
        $agentB = Start-HiddenNodeProcess -Arguments @(
            'apps/agent/src/main.mjs', '--repo', $paths.WorkspaceB, '--workspace', $Workspace,
            '--pipe', $pipeB, '--user', $SecondUser, '--color', '#66aaff', '--server', $serverUrl,
            '--state', $paths.AgentStateB
        ) -StandardOutput $agentBOutput -StandardError $agentBError
    }
    finally {
        if ($null -eq $previousToken) { Remove-Item Env:EAW_HUB_TOKEN -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_TOKEN = $previousToken }
        if ($null -eq $previousIpcSecret) { Remove-Item Env:EAW_HUB_IPC_SECRET -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_IPC_SECRET = $previousIpcSecret }
        $tokenA = $null
        $tokenB = $null
    }
    $startedProcesses.Add($agentA)
    $startedProcesses.Add($agentB)
    if (-not (Wait-ForLogText -Path $agentAOutput -Pattern 'pipe:' -Process $agentA)) {
        throw "First Agent did not become ready. See $agentAOutput"
    }
    if (-not (Wait-ForLogText -Path $agentBOutput -Pattern 'pipe:' -Process $agentB)) {
        throw "Second Agent did not become ready. See $agentBOutput"
    }

    $fileA = $preflightFileA
    $fileB = $preflightFileB
    $portableA = Join-Path $paths.PortableA 'notepad++.exe'
    $portableB = Join-Path $paths.PortableB 'notepad++.exe'
    $previousPipe = $env:EAW_HUB_PIPE
    $previousIpcSecret = $env:EAW_HUB_IPC_SECRET
    try {
        $env:EAW_HUB_PIPE = $pipeA
        $env:EAW_HUB_IPC_SECRET = $ipcSecretA
        $notepadA = Start-Process -FilePath $portableA -ArgumentList "-multiInst -nosession $(ConvertTo-ProcessArgument $fileA)" -PassThru
        $env:EAW_HUB_PIPE = $pipeB
        $env:EAW_HUB_IPC_SECRET = $ipcSecretB
        $notepadB = Start-Process -FilePath $portableB -ArgumentList "-multiInst -nosession $(ConvertTo-ProcessArgument $fileB)" -PassThru
    }
    finally {
        if ($null -eq $previousPipe) { Remove-Item Env:EAW_HUB_PIPE -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_PIPE = $previousPipe }
        if ($null -eq $previousIpcSecret) { Remove-Item Env:EAW_HUB_IPC_SECRET -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_IPC_SECRET = $previousIpcSecret }
    }
    $startedProcesses.Add($notepadA)
    $startedProcesses.Add($notepadB)

    $readyA = Wait-ForLogText -Path $agentAOutput -Pattern 'document ready' -TimeoutSeconds 20 -Process $agentA
    $readyB = Wait-ForLogText -Path $agentBOutput -Pattern 'document ready' -TimeoutSeconds 20 -Process $agentB
    if (-not ($readyA -and $readyB)) {
        throw 'Notepad++ plugins did not open both collaborative documents. Check Agent logs.'
    }

    $state = [pscustomobject]@{
        Version = '0.8.6F4'
        Status = 'running'
        SessionId = $sessionId
        StartedAt = [DateTime]::UtcNow.ToString('o')
        Workspace = $Workspace
        Authentication = if ($ProtectedAuth) { 'required-ephemeral-lab' } else { 'disabled' }
        ServerUrl = $serverUrl
        LogsDirectory = $paths.LogsDirectory
        Files = @($fileA, $fileB)
        Processes = @(
            [pscustomobject]@{ Role = 'server'; Id = $server.Id; Executable = $server.Path; CommandMarker = 'apps/server/src/main.mjs' }
            [pscustomobject]@{ Role = 'agent-a'; Id = $agentA.Id; Executable = $agentA.Path; CommandMarker = 'apps/agent/src/main.mjs' }
            [pscustomobject]@{ Role = 'agent-b'; Id = $agentB.Id; Executable = $agentB.Path; CommandMarker = 'apps/agent/src/main.mjs' }
            [pscustomobject]@{ Role = 'notepad-a'; Id = $notepadA.Id; Executable = $portableA }
            [pscustomobject]@{ Role = 'notepad-b'; Id = $notepadB.Id; Executable = $portableB }
        )
    }
    Write-JsonUtf8 -Value $state -Path $paths.StatePath
    Write-JsonUtf8 -Value ([pscustomobject]@{
        User = $User
        SecondUser = $SecondUser
        Workspace = $Workspace
        ProtectedAuth = [bool]$ProtectedAuth
    }) -Path $paths.ConfigPath
    $state
}
catch {
    foreach ($process in $startedProcesses) {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
    throw
}
