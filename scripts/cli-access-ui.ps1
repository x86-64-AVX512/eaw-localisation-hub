function Show-EawCliAccess {
    param($Owner, [string]$StateDirectory, [string]$Server)

    $startAgent = Get-EawUiText -Text 'Сначала запустите Desktop Agent.'
    $sessionPath = Join-Path $StateDirectory 'review-session.json'
    if (-not (Test-Path -LiteralPath $sessionPath -PathType Leaf)) { throw $startAgent }
    $session = Get-Content -LiteralPath $sessionPath -Raw -Encoding utf8 | ConvertFrom-Json
    $instance = Find-RegisteredAgentProcess
    if (-not $instance -or $instance.Id -ne [int]$session.pid -or
        $session.origin -cnotmatch '^http://127\.0\.0\.1:[1-9]\d{0,4}$' -or
        $session.token -cnotmatch '^[A-Za-z0-9_-]{43}$') { throw $startAgent }

    $view = @{
        Token = ''; Grants = @(); Mode = ''; Busy = $false
        Ready = Get-EawUiText -Text 'Доступ выдан. Передайте токен выбранному агенту.'
        ConnectionError = Get-EawUiText -Text 'Нет ответа от Desktop Agent.'
    }
    $requestKey = "cli-access-$([Guid]::NewGuid())"
    $dialog = [Windows.Forms.Form]::new()
    $dialog.Text = Get-EawUiText -Text 'Доступ CLI'
    $dialog.ClientSize = [Drawing.Size]::new(650, 420)
    $dialog.StartPosition = 'CenterParent'
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MinimizeBox = $false
    $dialog.MaximizeBox = $false

    function Add-CliControl($Control, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height) {
        $Control.Text = $Text
        $Control.SetBounds($X, $Y, $Width, $Height)
        $dialog.Controls.Add($Control)
        return $Control
    }

    [void](Add-CliControl ([Windows.Forms.Label]::new()) ([string]$session.repository) 15 16 620 28)
    [void](Add-CliControl ([Windows.Forms.Label]::new()) (Get-EawUiText -Text 'Режим CLI') 15 56 280 18)
    $modeNames = @('off', 'read', 'write')
    $modeLabels = @((Get-EawUiText -Text 'Выключено'), (Get-EawUiText -Text 'Только чтение'), (Get-EawUiText -Text 'Чтение и изменения'))
    $mode = Add-CliControl ([Windows.Forms.ComboBox]::new()) '' 15 76 440 25
    $mode.DropDownStyle = 'DropDownList'
    $mode.Items.AddRange($modeLabels)
    $save = Add-CliControl ([Windows.Forms.Button]::new()) (Get-EawUiText -Text 'Применить') 470 74 164 29
    [void](Add-CliControl ([Windows.Forms.Label]::new()) (Get-EawUiText -Text 'Название') 15 113 280 19)
    [void](Add-CliControl ([Windows.Forms.Label]::new()) (Get-EawUiText -Text 'Срок, минут') 315 113 141 19)
    $name = Add-CliControl ([Windows.Forms.TextBox]::new()) 'Agent' 15 135 285 25
    $name.MaxLength = 80
    $duration = Add-CliControl ([Windows.Forms.ComboBox]::new()) '' 315 135 141 25
    $duration.DropDownStyle = 'DropDownList'
    $duration.Items.AddRange(@('15', '60', '240'))
    $duration.SelectedIndex = 0
    $issue = Add-CliControl ([Windows.Forms.Button]::new()) (Get-EawUiText -Text 'Выдать доступ') 470 132 164 29
    $list = Add-CliControl ([Windows.Forms.ListBox]::new()) '' 15 173 619 155
    $revoke = Add-CliControl ([Windows.Forms.Button]::new()) (Get-EawUiText -Text 'Отозвать выбранный') 15 337 184 29
    $copy = Add-CliControl ([Windows.Forms.Button]::new()) (Get-EawUiText -Text 'Скопировать токен') 210 337 184 29
    $close = Add-CliControl ([Windows.Forms.Button]::new()) (Get-EawUiText -Text 'Закрыть') 470 337 164 29
    $status = Add-CliControl ([Windows.Forms.Label]::new()) '' 15 377 619 35
    $close.DialogResult = 'Cancel'
    $dialog.CancelButton = $close
    $revoke.Enabled = $false
    $copy.Enabled = $false

    $render = {
        $list.Items.Clear()
        foreach ($grant in $view.Grants) {
            $until = ([DateTimeOffset]::Parse([string]$grant.expiresAt)).LocalDateTime.ToString('g')
            $permission = if ($grant.scope -eq 'propose') { $modeLabels[2] } else { $modeLabels[1] }
            [void]$list.Items.Add(('{0} · {1} · {2}' -f $grant.label, $permission, $until))
        }
    }.GetNewClosure()
    $refreshControls = {
        $known = $view.Mode -ne ''
        $mode.Enabled = $known -and -not $view.Busy
        $waitingForApply = $mode.SelectedIndex -ge 0 -and $modeNames[$mode.SelectedIndex] -ne $view.Mode
        $save.Enabled = $mode.Enabled -and $waitingForApply
        $issue.Enabled = $mode.Enabled -and $view.Mode -ne 'off' -and -not $waitingForApply
        $revoke.Enabled = -not $view.Busy -and $list.SelectedIndex -ge 0
        $copy.Enabled = -not $view.Busy -and [bool]$view.Token
    }.GetNewClosure()
    $complete = {
        $view.Busy = $false
        & $refreshControls
    }.GetNewClosure()
    $failed = {
        param($result, $payload)
        $status.Text = if ($payload.error.message) { [string]$payload.error.message } else { $view.ConnectionError }
    }.GetNewClosure()
    $request = {
        param([string]$Route, [string]$Method, $Body, [scriptblock]$Success)
        $view.Busy = $true
        & $refreshControls
        $parameters = @{
            Key = $requestKey; Server = $Server; Url = $session.origin + '/api/cli/v1/' + $Route
            Method = $Method; Body = $Body; Token = $session.token; Success = $Success
            Failure = $failed; Complete = $complete; TimeoutMilliseconds = 22000
        }
        if (-not (Start-EawAgentRequest @parameters)) {
            & $failed $null $null
            & $complete
        }
    }.GetNewClosure()
    $settingsLoaded = {
        param($payload)
        $view.Mode = [string]$payload.data.mode
        $mode.SelectedIndex = [Array]::IndexOf($modeNames, $view.Mode)
        $view.Grants = @($payload.data.grants)
        if ($view.Mode -eq 'off') { $view.Token = ''; $view.TokenId = '' }
        $status.Text = ''
        & $render
    }.GetNewClosure()
    $issued = {
        param($payload)
        $view.Token = [string]$payload.data.token
        $view.TokenId = [string]$payload.data.id
        $payload.data.PSObject.Properties.Remove('token')
        $view.Grants += @($payload.data)
        $copy.Enabled = $true
        $status.Text = $view.Ready
        & $render
    }.GetNewClosure()
    $revoked = {
        if ($view.TokenId -eq $view.RevokingId) {
            $view.Token = ''
            $copy.Enabled = $false
        }
        $view.Grants = @($view.Grants | Where-Object { $_.id -ne $view.RevokingId })
        $view.RevokingId = ''
        $status.Text = ''
        & $render
    }.GetNewClosure()
    $list.Add_SelectedIndexChanged({
        & $refreshControls
    }.GetNewClosure())
    $mode.Add_SelectedIndexChanged({ & $refreshControls }.GetNewClosure())
    $save.Add_Click({
        & $request 'settings' 'PUT' @{ mode = $modeNames[$mode.SelectedIndex] } $settingsLoaded
    }.GetNewClosure())
    $issue.Add_Click({
        $body = @{
            label = $name.Text.Trim()
            minutes = [int]$duration.SelectedItem
        }
        & $request 'grants' 'POST' $body $issued
    }.GetNewClosure())
    $revoke.Add_Click({
        if ($list.SelectedIndex -lt 0) { return }
        $view.RevokingId = $view.Grants[$list.SelectedIndex].id
        & $request 'grants' 'DELETE' @{ id = $view.RevokingId } $revoked
    }.GetNewClosure())
    $copy.Add_Click({
        try { if ($view.Token) { [Windows.Forms.Clipboard]::SetText($view.Token) } }
        catch { $status.Text = $_.Exception.Message }
    }.GetNewClosure())
    try {
        & $request 'settings' 'GET' $null $settingsLoaded
        [void]$dialog.ShowDialog($Owner)
    } finally {
        Stop-EawAgentRequests -Keys @($requestKey)
        $view.Token = ''
        $dialog.Dispose()
    }
}
