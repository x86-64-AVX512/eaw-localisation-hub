$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$updaterPath = Join-Path $PSScriptRoot 'update-client.ps1'
. $updaterPath -ProjectRoot $sourceRoot -OwnerProcessId 2147483647 -OwnerStartedAtTicks 0
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($updaterPath, [ref]$tokens, [ref]$errors)
$entry = $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] } | Select-Object -Last 1
$entryBlock = [ScriptBlock]::Create($entry.Extent.Text)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('EaWHubUpdateConsent-' + [Guid]::NewGuid().ToString('N'))
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not [IO.Path]::GetFullPath($testRoot).StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid temporary test path.' }
New-Item -ItemType Directory -Path (Join-Path $testRoot 'client\review') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $testRoot 'client\scripts') -Force | Out-Null
$projectRoot = Join-Path $testRoot 'client'
[IO.File]::WriteAllText((Join-Path $projectRoot 'node.exe'), 'not executable')
[IO.File]::WriteAllText((Join-Path $projectRoot 'review\EaWReview.exe'), 'not executable')
[IO.File]::WriteAllText((Join-Path $projectRoot 'scripts\update-client.ps1'), 'fixture')
$stateRoot = Join-Path $testRoot 'state'
$updatesRoot = Join-Path $stateRoot 'updates'
$statusPath = Join-Path $stateRoot 'update-status.json'
$script:foundRelease = [pscustomobject]@{
    Version = '0.8.8F8'; InstallerName = 'EaW-Localisation-Hub-Setup-0.8.8F8.exe'
    Installer = [pscustomobject]@{ size = 4; browser_download_url = 'https://fixture.invalid/installer' }
    Checksum = [pscustomobject]@{ size = 100; browser_download_url = 'https://fixture.invalid/checksum' }
}
$script:downloads = 0
$script:mutations = 0
function Get-OwnerProcess { [pscustomobject]@{ Id = 2147483647 } }
function Get-EawHubClientStatusMetadata { param($ProjectRoot); [pscustomobject]@{ Version = '0.8.8F7' } }
function Find-NewClientRelease { param($InstalledVersion); $script:foundRelease }
function Show-ClientUpdateWindow { param($Version) }
function Save-ClientReleaseAsset {
    param($Url, $Destination, $ExpectedBytes, $Version, $TimeoutSeconds, [switch]$ReportProgress)
    $script:downloads++
    throw 'fixture-download-stop'
}
function Stop-CurrentClient { $script:mutations++; throw 'Client must not be stopped by this test.' }
function Invoke-ClientInstaller { $script:mutations++; throw 'Installer must not be launched by this test.' }
function Restart-UpdatedClient { $script:mutations++; throw 'Client must not be restarted by this test.' }

function Invoke-TestEntry {
    param([bool]$RequestInstall)
    $Install = [System.Management.Automation.SwitchParameter]::new($RequestInstall)
    $mutex = [System.Threading.Mutex]::new($false)
    $hasMutex = $false
    $workRoot = $null
    $clientStopped = $false
    & $entryBlock
    Get-Content -LiteralPath $statusPath -Raw -Encoding utf8 | ConvertFrom-Json
}

try {
    $record = Invoke-TestEntry -RequestInstall $false
    if ($record.Stage -cne 'available' -or $record.Version -cne '0.8.8F8' -or $record.InstallRequested -or
        $script:downloads -ne 0 -or $script:mutations -ne 0 -or (Test-Path -LiteralPath $updatesRoot)) {
        throw 'A check-only invocation downloaded, staged, stopped or installed the client.'
    }
    $record = Invoke-TestEntry -RequestInstall $true
    if ($record.Stage -cne 'error' -or -not $record.InstallRequested -or $record.Message -notmatch 'fixture-download-stop' -or
        $script:downloads -ne 1 -or $script:mutations -ne 0) { throw 'An explicit install request did not reach the download gate correctly.' }
    $script:foundRelease = $null
    $record = Invoke-TestEntry -RequestInstall $true
    if ($record.Stage -cne 'current' -or $script:downloads -ne 1 -or $script:mutations -ne 0) { throw 'An up-to-date client was changed by the button.' }

    # Exercise the actual Agent launcher function with a process spy, never launch it.
    $uiAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'start-agent-ui.ps1'), [ref]$tokens, [ref]$errors)
    $launcher = $uiAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-ClientUpdateCheck' }, $true)
    # Recreated script blocks do not retain the original automatic PSScriptRoot.
    $launcherText = $launcher.Extent.Text.Replace('$PSScriptRoot', ("'" + (Join-Path $projectRoot 'scripts').Replace("'", "''") + "'"))
    . ([ScriptBlock]::Create($launcherText))
    function Quote-AgentArgument { param($Value); '"' + $Value + '"' }
    $script:invocations = [System.Collections.Generic.List[string]]::new()
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
        $script:invocations.Add([string]$ArgumentList)
        [pscustomobject]@{ HasExited = $true }
    }
    $updateClientButton = [pscustomobject]@{ Enabled = $true }
    $status = [pscustomobject]@{ Text = '' }
    $script:clientUpdateProcess = $null
    $script:lastUpdateCheckAt = [DateTime]::MinValue
    Start-ClientUpdateCheck
    if ($script:invocations.Count -ne 1 -or $script:invocations[0] -match '(?:^|\s)-Install(?:\s|$)') { throw 'The background launcher requested installation.' }
    Start-ClientUpdateCheck -Install
    if ($script:invocations.Count -ne 2 -or $script:invocations[1] -notmatch ' -Install$' -or $updateClientButton.Enabled) {
        throw 'The button did not request installation, was incorrectly throttled or remained enabled.'
    }
    $script:clientUpdateProcess = [pscustomobject]@{ HasExited = $false }
    Start-ClientUpdateCheck -Install
    if ($script:invocations.Count -ne 2) { throw 'Repeated clicks launched simultaneous updates.' }
    Write-Output '[client-update-consent] check-only entry point, explicit download gate, current version, manual launcher and repeated-click protection passed'
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
