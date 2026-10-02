function Wait-ClientUpdateTask {
    param([Parameter(Mandatory = $true)]$Task,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None)
    while (-not $Task.IsCompleted) {
        $CancellationToken.ThrowIfCancellationRequested()
        Invoke-ClientUpdateUiPulse
        Start-Sleep -Milliseconds 40
    }
    $CancellationToken.ThrowIfCancellationRequested()
    $Task.GetAwaiter().GetResult()
}

function Save-ClientReleaseAsset {
    param([string]$Url, [string]$Destination, [long]$ExpectedBytes, [string]$Version,
        [int]$TimeoutSeconds = 600, [switch]$ReportProgress)
    Add-Type -AssemblyName System.Net.Http
    $http = [System.Net.Http.HttpClient]::new()
    $http.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
    $http.DefaultRequestHeaders.UserAgent.ParseAdd('EaWLocalisationHub-Updater')
    $cancel = [System.Threading.CancellationTokenSource]::new()
    $cancel.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
    $response = $null
    $inputStream = $null
    $outputStream = $null
    try {
        $response = Wait-ClientUpdateTask -Task ($http.GetAsync($Url,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token)) -CancellationToken $cancel.Token
        [void]$response.EnsureSuccessStatusCode()
        $inputStream = Wait-ClientUpdateTask -Task ($response.Content.ReadAsStreamAsync()) -CancellationToken $cancel.Token
        $outputStream = [System.IO.FileStream]::new($Destination, [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $buffer = [byte[]]::new(65536)
        $received = [long]0
        $nextReport = [DateTime]::MinValue
        $total = if ($ExpectedBytes -gt 0) { $ExpectedBytes } else { [long]$response.Content.Headers.ContentLength }
        while ($true) {
            $count = Wait-ClientUpdateTask -Task ($inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)) -CancellationToken $cancel.Token
            if ($count -eq 0) { break }
            $outputStream.Write($buffer, 0, $count)
            $received += $count
            if ($ExpectedBytes -gt 0 -and $received -gt $ExpectedBytes) { throw 'Downloaded asset exceeds the expected size.' }
            if ($ReportProgress -and [DateTime]::UtcNow -ge $nextReport) {
                $percent = if ($total -gt 0) { [int][Math]::Floor(100.0 * $received / $total) } else { $null }
                Write-UpdateStatus -Stage 'downloading' -Message "Скачивается установщик $Version с GitHub Releases…" `
                    -Version $Version -ProgressPercent $percent -BytesReceived $received -BytesTotal $total
                $nextReport = [DateTime]::UtcNow.AddMilliseconds(250)
            }
            Invoke-ClientUpdateUiPulse
        }
        if ($ExpectedBytes -gt 0 -and $received -ne $ExpectedBytes) { throw 'Downloaded asset is incomplete.' }
        if ($ReportProgress) {
            Write-UpdateStatus -Stage 'downloading' -Message "Установщик $Version скачан." -Version $Version `
                -ProgressPercent 100 -BytesReceived $received -BytesTotal $total
        }
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        $cancel.Dispose()
        $http.Dispose()
    }
}
