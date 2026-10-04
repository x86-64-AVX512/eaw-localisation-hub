# Tests use isolated state, no live repository, no sound/flash and no network.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'repository-sync-ui.ps1')
# Keep label assertions independent of Windows culture and live user settings.
function Get-EawUiLanguageSettings { [pscustomobject]@{ language = 'ru'; preference = 'ru' } }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('EaWHubGitSync-' + [Guid]::NewGuid().ToString('N'))
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not [IO.Path]::GetFullPath($taskRoot).StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid temporary path.' }
try {
    $repository = Join-Path $taskRoot 'Repo'
    $directory = Get-EawRepositorySyncDirectory $taskRoot $repository
    if ($directory -cne (Get-EawRepositorySyncDirectory $taskRoot ($repository.ToUpperInvariant() + '\'))) { throw 'Repository identity is not case/ending insensitive.' }
    $identity = [IO.Path]::GetFullPath($repository).ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ((Split-Path -Leaf $directory) -cne $digest) { throw 'Node/PowerShell repository identity contract is broken.' }
    $settings = Get-EawRepositorySyncSettings $directory
    if ($settings.autoFetch -or $settings.autoPull -or -not $settings.sound -or -not $settings.flash -or -not $settings.notification) { throw 'Unsafe defaults.' }
    $settings.autoPull = $true; $settings.sound = $false; $settings.intervalMinutes = 10
    Write-EawRepositorySyncJson (Join-Path $directory 'settings.json') $settings
    $saved = Get-EawRepositorySyncSettings $directory
    if (-not $saved.autoPull -or $saved.sound -or $saved.intervalMinutes -ne 10) { throw 'Settings did not round trip.' }
    foreach ($minutes in @(1, 5, 10, 15, 30)) {
        $saved.intervalMinutes = $minutes
        Write-EawRepositorySyncJson (Join-Path $directory 'settings.json') $saved
        if ((Get-EawRepositorySyncSettings $directory).intervalMinutes -ne $minutes) { throw "Interval $minutes did not round trip." }
    }
    $saved.intervalMinutes = 2
    Write-EawRepositorySyncJson (Join-Path $directory 'settings.json') $saved
    if ((Get-EawRepositorySyncSettings $directory).intervalMinutes -ne 5) { throw 'Invalid interval did not fall back to five minutes.' }
    $saved.intervalMinutes = 1
    $saved.autoPull = $false
    Write-EawRepositorySyncJson (Join-Path $directory 'settings.json') $saved
    if ((Get-EawRepositorySyncSettings $directory).autoPull) { throw 'Atomic settings replacement failed.' }
    Request-EawRepositorySync $directory 12345 'check'
    $request = Read-EawRepositorySyncJson (Join-Path $directory 'request.json')
    if ($request.pid -ne 12345 -or $request.action -cne 'check' -or -not $request.id) { throw 'Invalid request contract.' }
    $statusValue = [pscustomobject]@{ schema = 1; pid = 12345; repository = $repository; updatedAt = [DateTime]::UtcNow.ToString('o') }
    if (-not (Test-EawRepositorySyncStatus $statusValue 12345 $repository)) { throw 'Current status rejected.' }
    if (Test-EawRepositorySyncStatus $statusValue 54321 $repository) { throw 'Foreign Agent accepted.' }
    if (Test-EawRepositorySyncStatus $statusValue 12345 ($repository + '-other')) { throw 'Foreign repository accepted.' }
    $statusValue.updatedAt = [DateTime]::UtcNow.AddMinutes(-5).ToString('o')
    if (Test-EawRepositorySyncStatus $statusValue 12345 $repository) { throw 'Stale status accepted.' }

    $clock = [DateTime]::Parse('2026-10-02T12:00:00Z').ToUniversalTime()
    $timing = [pscustomobject]@{ checkedAt = $clock.ToString('o'); nextCheckAt = $clock.AddMinutes(1).ToString('o'); stage = 'current'
        settings = [pscustomobject]@{ autoFetch = $true; autoPull = $false } }
    $initialTiming = Get-EawRepositorySyncTiming $timing $clock
    if ($initialTiming -notmatch 'Следующая через 01:00') { throw 'One-minute countdown is missing.' }
    if ((Get-EawRepositorySyncTiming $timing $clock.AddSeconds(1)) -notmatch 'Следующая через 00:59') { throw 'Countdown did not tick without a status update.' }
    if ((Get-EawRepositorySyncTiming $timing $clock.AddMinutes(2)) -notmatch 'Следующая: скоро') { throw 'Expired deadline produced a negative countdown.' }
    $timing.stage = 'fetching'
    if ((Get-EawRepositorySyncTiming $timing $clock) -notmatch 'Проверка выполняется') { throw 'An active fetch still displayed a countdown.' }
    $timing.stage = 'current'; $timing.settings.autoFetch = $false
    if ((Get-EawRepositorySyncTiming $timing $clock) -notmatch 'Автопроверка выключена') { throw 'Disabled automation still displayed a countdown.' }
    $timing.settings.autoFetch = $true; $timing.checkedAt = ''; $timing.nextCheckAt = 'invalid'
    if ((Get-EawRepositorySyncTiming $timing $clock) -notmatch 'ещё не было.*Расписание пока недоступно') { throw 'Missing/invalid timestamps were not handled.' }

    # Exercise the actual view, replacing all signals with a spy.
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'start-agent-ui.ps1'), [ref]$tokens, [ref]$errors)
    foreach ($name in @('Update-RepositorySyncTiming', 'Update-RepositorySyncView')) {
        $view = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        . ([ScriptBlock]::Create($view.Extent.Text))
    }
    # Build only the real Git group off-screen: no Agent launch or user dialog.
    $source = $ast.Extent.Text
    $layoutStart = $source.IndexOf('$repositoryGroup =')
    $layoutEnd = $source.IndexOf('$tray =', $layoutStart)
    if ($layoutStart -lt 0 -or $layoutEnd -le $layoutStart) { throw 'Git group layout was not found.' }
    $form = [Windows.Forms.Form]::new()
    . ([ScriptBlock]::Create($source.Substring($layoutStart, $layoutEnd - $layoutStart)))
    $script:signals = 0
    function Show-EawRepositorySyncAlert { param($Owner, $Tray, $Settings, $Message); $script:signals++ }
    function Sync-AgentProcessReference { [pscustomobject]@{ Id = 12345; HasExited = $false } }
    $stateDirectory = $taskRoot
    $repoBox = [pscustomobject]@{ Text = $repository }
    $script:seenRepositoryAlerts = @{}
    $script:stateTextChanges = 0; $script:stateColorChanges = 0; $script:buttonChanges = 0
    $script:timingChanges = [Collections.Generic.List[string]]::new()
    $repositoryState.Add_TextChanged({ $script:stateTextChanges++ })
    $repositoryState.Add_ForeColorChanged({ $script:stateColorChanges++ })
    $repositoryButtons.check.Add_EnabledChanged({ $script:buttonChanges++ })
    $repositoryButtons.update.Add_EnabledChanged({ $script:buttonChanges++ })
    $repositoryTiming.Add_TextChanged({ $script:timingChanges.Add($repositoryTiming.Text) })
    $statusValue = [pscustomobject]@{ schema = 1; pid = 12345; repository = $repository; updatedAt = [DateTime]::UtcNow.ToString('o')
        stage = 'blocked'; branch = 'barrad'; behind = 2; message = 'Локальные изменения'; alertId = 'episode-1'
        checkedAt = $clock.ToString('o'); nextCheckAt = [DateTime]::UtcNow.AddMinutes(1).ToString('o'); settings = $timing.settings }
    Write-EawRepositorySyncJson (Join-Path $directory 'status.json') $statusValue
    Update-RepositorySyncView; Update-RepositorySyncView
    if ($script:signals -ne 1 -or $repositoryState.Text -notmatch 'barrad') { throw 'Repeated polls produced repeated notifications.' }
    if ($script:stateTextChanges -ne 1 -or $script:stateColorChanges -ne 1 -or $script:buttonChanges -ne 0 -or $script:timingChanges.Contains('')) {
        throw 'An unchanged status was cleared or repainted during a timer tick.'
    }
    $script:repositorySyncStatus.nextCheckAt = [DateTime]::UtcNow.AddSeconds(30).ToString('o')
    Update-RepositorySyncTiming
    if ($repositoryTiming.Text -notmatch 'Следующая через 00:30' -or $script:stateTextChanges -ne 1 -or $script:buttonChanges -ne 0) {
        throw 'The standalone countdown tick changed the status or buttons.'
    }
    if ($repositoryTiming.Text -notmatch 'Последняя проверка:.*Следующая через') { throw 'Timing is not rendered in the Agent view.' }
    $textSize = [Windows.Forms.TextRenderer]::MeasureText($repositoryTiming.Text, $repositoryTiming.Font)
    if ($textSize.Width -gt $repositoryTiming.Width -or $textSize.Height -gt $repositoryTiming.Height) { throw 'Timing text is clipped.' }
    if ($repositoryState.Bottom -gt $repositoryTiming.Top -or $repositoryTiming.Bottom -gt $repositoryButtons.check.Top -or
        $repositoryButtons.check.Bottom -gt $repositoryGroup.Height) { throw 'Git timing overlaps status or buttons.' }
    $statusValue.alertId = ''; $statusValue.stage = 'error'
    Write-EawRepositorySyncJson (Join-Path $directory 'status.json') $statusValue
    Update-RepositorySyncView
    if ($script:signals -ne 1) { throw 'Network errors must not trigger blocking signals.' }
    $statusValue.alertId = 'episode-2'; $statusValue.stage = 'blocked'
    Write-EawRepositorySyncJson (Join-Path $directory 'status.json') $statusValue
    Update-RepositorySyncView
    if ($script:signals -ne 2) { throw 'A new blocking episode was ignored.' }
    $statusValue.stage = 'fetching'; $statusValue.alertId = ''
    Write-EawRepositorySyncJson (Join-Path $directory 'status.json') $statusValue
    $previousButtonChanges = $script:buttonChanges
    Update-RepositorySyncView; Update-RepositorySyncView
    if ($repositoryButtons.check.Enabled -or $repositoryButtons.update.Enabled -or $script:buttonChanges -ne ($previousButtonChanges + 2)) {
        throw 'A real fetch must disable each button once, without flickering on repeated polls.'
    }
    $statusValue.stage = 'current'
    Write-EawRepositorySyncJson (Join-Path $directory 'status.json') $statusValue
    Update-RepositorySyncView
    if (-not $repositoryButtons.check.Enabled -or -not $repositoryButtons.update.Enabled) { throw 'Buttons did not recover after fetch.' }
    $repoBox.Text += '-other'; Update-RepositorySyncView
    if ($script:signals -ne 2 -or $repositoryButtons.update.Enabled -or $repositoryTiming.Text) { throw 'A different repository received the previous status/timing.' }
    Write-Output '[repository-sync] settings, atomic replacement, repository identity, request/status isolation and notification deduplication passed'
} finally {
    if ($form) { $form.Dispose() }
    Remove-Item -LiteralPath $taskRoot -Recurse -Force
}
