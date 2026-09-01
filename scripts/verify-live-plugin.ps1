param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-prototype-common.ps1')
$paths = Get-LocalPrototypePaths
$runId = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$smokeRoot = Join-Path $paths.ProjectRoot ".tools\live-plugin-smoke\$runId"
$logs = Join-Path $smokeRoot 'logs'
$workspaceA = Join-Path $smokeRoot 'workspace-a'
$workspaceB = Join-Path $smokeRoot 'workspace-b'
$relativeFile = 'localisation\russian\live_probe_l_russian.yml'
$fileA = Join-Path $workspaceA $relativeFile
$fileB = Join-Path $workspaceB $relativeFile
$secondFileA = Join-Path $workspaceA 'localisation\russian\live_second_l_russian.yml'
$probe = Join-Path $smokeRoot 'scintilla-probe.exe'
$marker = "__EAW_LIVE_SYNC_${runId}__"
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Save-LiveFailureScreenshot([string]$Name) {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $logs $Name), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

New-Item -ItemType Directory -Path $logs, (Split-Path -Parent $fileA), (Split-Path -Parent $fileB) -Force | Out-Null
$initial = @'
l_russian:
 EAW_LIVE_ONE:0 "One"
 EAW_LIVE_TWO:0 "Two"
'@ -replace "`n", "`r`n"
[System.IO.File]::WriteAllText($fileA, $initial, [System.Text.UTF8Encoding]::new($true))
[System.IO.File]::WriteAllText($fileB, $initial, [System.Text.UTF8Encoding]::new($true))
[System.IO.File]::WriteAllText($secondFileA, $initial, [System.Text.UTF8Encoding]::new($true))

& (Join-Path $PSScriptRoot 'prepare-local-prototype.ps1') -SkipBuild | Out-Null
foreach ($portable in @($paths.PortableA, $paths.PortableB)) {
    $pluginConfig = Join-Path $portable 'plugins\Config'
    New-Item -ItemType Directory -Path $pluginConfig -Force | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $pluginConfig 'EawLocalisationHub.ini'),
        "[LegacyIntegration]`r`nEnabled=1`r`n",
        [System.Text.UTF8Encoding]::new($false))
}
$zig = Join-Path $paths.ProjectRoot '.tools\zig-extract\zig-windows-x86_64-0.13.0\zig.exe'
& $zig c++ (Join-Path $paths.ProjectRoot 'test\native\scintilla-probe.cpp') `
    -target x86_64-windows-gnu -std=c++20 -O0 -static -lgdi32 -o $probe
if ($LASTEXITCODE -ne 0) { throw 'Failed to build the live Scintilla probe.' }

try {
    $port = Get-FreeLocalPort
    $serverUrl = "ws://127.0.0.1:$port"
    $serverOut = Join-Path $logs 'server.out.log'
    $serverErr = Join-Path $logs 'server.err.log'
    $agentAOut = Join-Path $logs 'agent-a.out.log'
    $agentAErr = Join-Path $logs 'agent-a.err.log'
    $agentBOut = Join-Path $logs 'agent-b.out.log'
    $agentBErr = Join-Path $logs 'agent-b.err.log'
    $pipeA = "eaw-live-$runId-a"
    $pipeB = "eaw-live-$runId-b"
    $ipcSecretA = [Guid]::NewGuid().ToString('N')
    $ipcSecretB = [Guid]::NewGuid().ToString('N')

    $server = Start-HiddenNodeProcess -Arguments @(
        'apps/server/src/main.mjs', '--host', '127.0.0.1', '--port', [string]$port,
        '--data', (Join-Path $smokeRoot 'server-data'), '--auth', 'disabled'
    ) -StandardOutput $serverOut -StandardError $serverErr
    $processes.Add($server)
    if (-not (Wait-ForLogText -Path $serverOut -Pattern 'listening on' -Process $server)) {
        throw 'Live smoke server did not become ready.'
    }

    $previousIpcSecret = $env:EAW_HUB_IPC_SECRET
    try {
        $env:EAW_HUB_IPC_SECRET = $ipcSecretA
        $agentA = Start-HiddenNodeProcess -Arguments @(
            'apps/agent/src/main.mjs', '--repo', $workspaceA, '--workspace', 'live-smoke',
            '--pipe', $pipeA, '--user', 'Live A', '--color', '#ff6677', '--server', $serverUrl,
            '--state', (Join-Path $smokeRoot 'state-a')
        ) -StandardOutput $agentAOut -StandardError $agentAErr
        $env:EAW_HUB_IPC_SECRET = $ipcSecretB
        $agentB = Start-HiddenNodeProcess -Arguments @(
            'apps/agent/src/main.mjs', '--repo', $workspaceB, '--workspace', 'live-smoke',
            '--pipe', $pipeB, '--user', 'Live B', '--color', '#66aaff', '--server', $serverUrl,
            '--state', (Join-Path $smokeRoot 'state-b')
        ) -StandardOutput $agentBOut -StandardError $agentBErr
    } finally {
        if ($null -eq $previousIpcSecret) { Remove-Item Env:EAW_HUB_IPC_SECRET -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_IPC_SECRET = $previousIpcSecret }
    }
    $processes.Add($agentA)
    $processes.Add($agentB)
    if (-not (Wait-ForLogText -Path $agentAOut -Pattern 'pipe:' -Process $agentA)) { throw 'Live Agent A did not start.' }
    if (-not (Wait-ForLogText -Path $agentBOut -Pattern 'pipe:' -Process $agentB)) { throw 'Live Agent B did not start.' }

    $previousPipe = $env:EAW_HUB_PIPE
    $previousIpcSecret = $env:EAW_HUB_IPC_SECRET
    try {
        $env:EAW_HUB_PIPE = $pipeA
        $env:EAW_HUB_IPC_SECRET = $ipcSecretA
        $notepadA = Start-Process -FilePath (Join-Path $paths.PortableA 'notepad++.exe') `
            -ArgumentList "-multiInst -nosession $(ConvertTo-ProcessArgument $fileA)" -PassThru
        $env:EAW_HUB_PIPE = $pipeB
        $env:EAW_HUB_IPC_SECRET = $ipcSecretB
        $notepadB = Start-Process -FilePath (Join-Path $paths.PortableB 'notepad++.exe') `
            -ArgumentList "-multiInst -nosession $(ConvertTo-ProcessArgument $fileB)" -PassThru
    }
    finally {
        if ($null -eq $previousPipe) { Remove-Item Env:EAW_HUB_PIPE -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_PIPE = $previousPipe }
        if ($null -eq $previousIpcSecret) { Remove-Item Env:EAW_HUB_IPC_SECRET -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_IPC_SECRET = $previousIpcSecret }
    }
    $processes.Add($notepadA)
    $processes.Add($notepadB)

    if (-not (Wait-ForLogText -Path $agentAOut -Pattern 'document ready' -TimeoutSeconds 20 -Process $agentA)) {
        throw 'Notepad A plugin did not open its live smoke document.'
    }
    if (-not (Wait-ForLogText -Path $agentBOut -Pattern 'document ready' -TimeoutSeconds 20 -Process $agentB)) {
        throw 'Notepad B plugin did not open its live smoke document.'
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $panelsReady = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) panel-ready ignored 2>$null
        $panelAReady = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) panel-ready ignored 2>$null
        $panelBReady = $LASTEXITCODE -eq 0
        if ($panelAReady -and $panelBReady) {
            $panelsReady = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $panelsReady) { throw 'The collaboration panel did not become ready in both Notepad++ processes.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $presenceVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) participant-count 2 2>$null
        $presenceA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) participant-count 2 2>$null
        $presenceB = $LASTEXITCODE -eq 0
        if ($presenceA -and $presenceB) {
            $presenceVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $presenceVisible) { throw 'Both participants did not appear in both collaboration panels.' }

    & $probe ([string]$notepadA.Id) open-file $secondFileA
    if ($LASTEXITCODE -ne 0) { throw 'Could not open the second live tab.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $oldPresenceCleared = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) participant-count 1 2>$null
        if ($LASTEXITCODE -eq 0) {
            $oldPresenceCleared = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $oldPresenceCleared) { throw 'The participant remained visible in the previously active tab.' }

    & $probe ([string]$notepadA.Id) switch-file $fileA
    if ($LASTEXITCODE -ne 0) { throw 'Could not switch back to the primary live tab.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $returnedPresenceVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) participant-count 2 2>$null
        if ($LASTEXITCODE -eq 0) {
            $returnedPresenceVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $returnedPresenceVisible) { throw 'The participant did not reappear after returning to the tab.' }

    & $probe ([string]$notepadA.Id) select-prefix 8
    if ($LASTEXITCODE -ne 0) { throw 'Could not create a live text selection for the first participant.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $remoteSelectionVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) presence-selection '#ff6677' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $remoteSelectionVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $remoteSelectionVisible) {
        throw 'The first participant text selection was not rendered for the second participant.'
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $targetsVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) reservation-target-count 2 2>$null
        $targetsA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) reservation-target-count 2 2>$null
        $targetsB = $LASTEXITCODE -eq 0
        if ($targetsA -and $targetsB) {
            $targetsVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $targetsVisible) {
        throw "Reservation assignee choices did not appear in both collaboration panels (A=$targetsA, B=$targetsB)."
    }

    & $probe ([string]$notepadA.Id) caret-eof ignored
    if ($LASTEXITCODE -ne 0) { throw 'Could not move the first participant caret to the empty EOF line.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $emptyLineCaretVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) overlay-color '#ff6677' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $emptyLineCaretVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $emptyLineCaretVisible) {
        throw 'The named remote caret was not rendered on the empty EOF line.'
    }

    & $probe ([string]$notepadB.Id) jump-participant 1
    if ($LASTEXITCODE -ne 0) { throw 'Could not click the remote participant in the collaboration panel.' }
    & $probe ([string]$notepadB.Id) caret-is-eof ignored
    if ($LASTEXITCODE -ne 0) { throw 'Clicking a participant did not jump to the remote caret.' }

    & $probe ([string]$notepadB.Id) mouse-away ignored
    if ($LASTEXITCODE -ne 0) { throw 'Could not move the pointer away from the remote caret.' }
    & $probe ([string]$notepadB.Id) overlay-label '#ff6677' 2>$null
    if ($LASTEXITCODE -eq 0) {
        Save-LiveFailureScreenshot 'away-failure.png'
        throw 'The participant name is visible without hovering the remote caret.'
    }
    & $probe ([string]$notepadB.Id) hover-color '#ff6677'
    if ($LASTEXITCODE -ne 0) { throw 'Could not hover the remote caret.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    $hoverLabelVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) overlay-label '#ff6677' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $hoverLabelVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $hoverLabelVisible) {
        Save-LiveFailureScreenshot 'hover-failure.png'
        throw 'The participant name did not appear when hovering the remote caret.'
    }
    & $probe ([string]$notepadB.Id) mouse-away ignored

    $markerInsertion = "`r`n# $marker"
    & $probe ([string]$notepadA.Id) add $markerInsertion
    if ($LASTEXITCODE -ne 0) { throw 'Could not inject an edit into the first live Notepad++ buffer.' }
    & $probe ([string]$notepadA.Id) contains $marker
    if ($LASTEXITCODE -ne 0) { throw 'The injected edit is not visible in the first Notepad++ buffer.' }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $converged = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) contains $marker 2>$null
        if ($LASTEXITCODE -eq 0) {
            $converged = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $converged) {
        $secondBuffer = & $probe ([string]$notepadB.Id) dump ignored
        [System.IO.File]::WriteAllText(
            (Join-Path $logs 'notepad-b-buffer.txt'),
            [string]$secondBuffer,
            [System.Text.UTF8Encoding]::new($false))
        throw 'The edit did not appear in the second live Notepad++ buffer.'
    }

    & $probe ([string]$notepadA.Id) undo ignored
    if ($LASTEXITCODE -ne 0) { throw 'Native Notepad++ undo was not available in the Russian localisation buffer.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) contains $marker 2>$null
        if ($LASTEXITCODE -ne 0) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($LASTEXITCODE -eq 0) { throw 'Native Notepad++ undo did not converge to the second participant.' }
    & $probe ([string]$notepadA.Id) redo ignored
    if ($LASTEXITCODE -ne 0) { throw 'Native Notepad++ redo was not available in the Russian localisation buffer.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) contains $marker 2>$null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 100
    }
    if ($LASTEXITCODE -ne 0) { throw 'Native Notepad++ redo did not converge to the second participant.' }

    $documentId = 'live-smoke:localisation/russian/live_probe_l_russian.yml'
    & $probe ([string]$notepadA.Id) select-reservation-target 1
    if ($LASTEXITCODE -ne 0) { throw 'Could not select the other participant as reservation assignee.' }
    & $probe ([string]$notepadA.Id) reserve ignored
    if ($LASTEXITCODE -ne 0) { throw 'Could not invoke the reservation command in live Notepad++.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $reservationCreated = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $inspection = @(& node (Join-Path $paths.ProjectRoot 'scripts\inspect-room.mjs') `
            --server $serverUrl --document $documentId 2>$null) -join "`n"
        if ($LASTEXITCODE -eq 0 -and $inspection) {
            $room = $inspection | ConvertFrom-Json
            if ([int]$room.reservations -eq 1) {
                $reservationCreated = $true
                break
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $reservationCreated) { throw 'The live reservation did not reach the collaborative server.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $reservationVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) reservation-count 1 2>$null
        $visibleA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) reservation-count 1 2>$null
        $visibleB = $LASTEXITCODE -eq 0
        if ($visibleA -and $visibleB) {
            $reservationVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $reservationVisible) { throw 'The live reservation did not appear in both collaboration panels.' }
    & $probe ([string]$notepadA.Id) reservation-color '#66aaff'
    if ($LASTEXITCODE -ne 0) { throw 'The delegated reservation did not use its assignee colour in the first editor.' }
    & $probe ([string]$notepadB.Id) reservation-color '#66aaff'
    if ($LASTEXITCODE -ne 0) { throw 'The delegated reservation did not use its assignee colour in the second editor.' }
    & $probe ([string]$notepadB.Id) hover-reservation ignored
    if ($LASTEXITCODE -ne 0) { throw 'The reservation hover label could not be displayed.' }
    & $probe ([string]$notepadB.Id) mouse-away ignored

    & $probe ([string]$notepadA.Id) delete-at ignored
    if ($LASTEXITCODE -ne 0) { throw 'Could not invoke live reservation deletion.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $reservationDeleted = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $inspection = @(& node (Join-Path $paths.ProjectRoot 'scripts\inspect-room.mjs') `
            --server $serverUrl --document $documentId 2>$null) -join "`n"
        if ($LASTEXITCODE -eq 0 -and $inspection) {
            $room = $inspection | ConvertFrom-Json
            if ([int]$room.reservations -eq 0) {
                $reservationDeleted = $true
                break
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $reservationDeleted) { throw 'The live reservation was not deleted from the server.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $reservationRemovedFromPanels = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) reservation-count 0 2>$null
        $removedA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) reservation-count 0 2>$null
        $removedB = $LASTEXITCODE -eq 0
        if ($removedA -and $removedB) {
            $reservationRemovedFromPanels = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $reservationRemovedFromPanels) { throw 'The deleted reservation remained in a collaboration panel.' }

    & $probe ([string]$notepadA.Id) create-suggestion ignored
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the live colour suggestion.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $suggestionVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) suggestion-count 1 2>$null
        $suggestionA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) suggestion-count 1 2>$null
        $suggestionB = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadA.Id) suggestion-visual '#ff6677' 2>$null
        $visualA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) suggestion-visual '#ff6677' 2>$null
        $visualB = $LASTEXITCODE -eq 0
        if ($suggestionA -and $suggestionB -and $visualA -and $visualB) {
            $suggestionVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $suggestionVisible) { throw 'The coloured strike-through, inline ghost, or suggestion cards did not appear in both editors.' }

    & $probe ([string]$notepadB.Id) set-suggestion-mode 2
    if ($LASTEXITCODE -ne 0) { throw 'Could not switch suggestion display to hidden mode.' }
    & $probe ([string]$notepadB.Id) suggestion-hidden ignored
    if ($LASTEXITCODE -ne 0) { throw 'Hidden suggestion mode left an editor strike-through or ghost visible.' }
    & $probe ([string]$notepadB.Id) set-suggestion-mode 1
    if ($LASTEXITCODE -ne 0) { throw 'Could not switch suggestion display to compact mode.' }
    & $probe ([string]$notepadB.Id) suggestion-visual '#ff6677'
    if ($LASTEXITCODE -ne 0) { throw 'Compact suggestion mode did not restore the strike-through and ghost.' }
    & $probe ([string]$notepadB.Id) set-suggestion-mode 0
    if ($LASTEXITCODE -ne 0) { throw 'Could not restore Google Docs suggestion display mode.' }

    & $probe ([string]$notepadB.Id) accept-suggestion ignored
    if ($LASTEXITCODE -ne 0) { throw 'Could not accept the live suggestion from the second panel.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $suggestionApplied = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) contains '"Proposed"' 2>$null
        $appliedA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) contains '"Proposed"' 2>$null
        $appliedB = $LASTEXITCODE -eq 0
        if ($appliedA -and $appliedB) {
            $suggestionApplied = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $suggestionApplied) { throw 'The accepted live suggestion did not converge in both editors.' }

    & $probe ([string]$notepadA.Id) create-comment ignored
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the live comment card.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $commentCardsVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) comment-card 1 2>$null
        $commentA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) comment-card 1 2>$null
        $commentB = $LASTEXITCODE -eq 0
        if ($commentA -and $commentB) {
            $commentCardsVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $commentCardsVisible) { throw 'The owner-drawn comment card did not appear in both panels.' }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $bothFilesSaved = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        $savedA = [System.IO.File]::ReadAllText($fileA).Contains($marker)
        $savedB = [System.IO.File]::ReadAllText($fileB).Contains($marker)
        if ($savedA -and $savedB) {
            $bothFilesSaved = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $bothFilesSaved) { throw 'Collaborative buffers were not automatically saved to both local files.' }

    $externalValue = "Git disk $runId"
    $externalText = [System.IO.File]::ReadAllText($fileB).Replace(
        'EAW_LIVE_TWO:0 "Two"',
        "EAW_LIVE_TWO:0 `"$externalValue`"")
    [System.IO.File]::WriteAllText($fileB, $externalText, [System.Text.UTF8Encoding]::new($true))
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $externalMerged = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) contains $externalValue 2>$null
        $externalA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) contains $externalValue 2>$null
        $externalB = $LASTEXITCODE -eq 0
        if ($externalA -and $externalB) {
            $externalMerged = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $externalMerged) { throw 'A non-conflicting Git disk edit did not merge into both buffers.' }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $externalSavedEverywhere = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if (
            [System.IO.File]::ReadAllText($fileA).Contains($externalValue) -and
            [System.IO.File]::ReadAllText($fileB).Contains($externalValue)
        ) {
            $externalSavedEverywhere = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $externalSavedEverywhere) { throw 'The merged Git disk edit was not materialised in both local files.' }

    Start-Sleep -Milliseconds 500
    $collaborativeMarker = "__COLLAB_CONFLICT_${runId}__"
    & $probe ([string]$notepadA.Id) add $collaborativeMarker
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the live collaborative side of a disk conflict.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) contains $collaborativeMarker 2>$null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 50
    }
    if ($LASTEXITCODE -ne 0) { throw 'The collaborative conflict marker did not reach the second buffer.' }

    $gitComment = "# Git conflict choice $runId"
    $externalConflictText = [System.IO.File]::ReadAllText($fileB).Replace($collaborativeMarker, '')
    $externalConflictText = $externalConflictText.Replace('l_russian:', "l_russian:`r`n $gitComment")
    [System.IO.File]::WriteAllText($fileB, $externalConflictText, [System.Text.UTF8Encoding]::new($true))
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $conflictVisible = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadB.Id) conflict-count 1 2>$null
        if ($LASTEXITCODE -eq 0) {
            $conflictVisible = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $conflictVisible) { throw 'The Git disk conflict did not appear in the collaboration panel.' }

    & $probe ([string]$notepadB.Id) resolve-external ignored
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the live conflict with the Git choice.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $conflictResolved = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & $probe ([string]$notepadA.Id) contains $gitComment 2>$null
        $gitChoiceA = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) contains $gitComment 2>$null
        $gitChoiceB = $LASTEXITCODE -eq 0
        & $probe ([string]$notepadB.Id) conflict-count 0 2>$null
        $panelCleared = $LASTEXITCODE -eq 0
        if ($gitChoiceA -and $gitChoiceB -and $panelCleared) {
            $conflictResolved = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $conflictResolved) { throw 'The Git conflict choice did not converge or leave the panel.' }

    Write-Output '[live-plugin-smoke] native undo/redo, presence, remote selections, delegated colours, review modes, comment cards, suggestion cards, inline ghost, acceptance, autosave, disk merge, and conflict UI passed in two Notepad++ processes'
    Write-Output "[live-plugin-smoke] logs: $logs"
}
finally {
    $cleanupProcesses = @($processes.ToArray())
    [array]::Reverse($cleanupProcesses)
    foreach ($process in $cleanupProcesses) {
        if (-not $process.HasExited) {
            if ($process.ProcessName -eq 'notepad++') {
                $null = $process.CloseMainWindow()
                $null = $process.WaitForExit(2000)
            }
            if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        }
    }
}
