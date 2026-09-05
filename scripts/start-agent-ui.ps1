param([switch]$StartMinimized)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'credential-store.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'agent-status.ps1')
$clientStatusMetadata = Get-EawHubClientStatusMetadata -ProjectRoot $projectRoot
$stateDirectory = Join-Path $env:LOCALAPPDATA 'EaWLocalisationHub'
$configPath = Join-Path $stateDirectory 'agent-config.json'
$instancePath = Join-Path $stateDirectory 'agent-instance.json'
$logDirectory = Join-Path $stateDirectory 'logs'
$script:agentProcess = $null
$script:allowExit = $false

function Find-RegisteredAgentProcess {
    if (-not (Test-Path -LiteralPath $instancePath -PathType Leaf)) { return $null }
    try {
        $instance = Get-Content -LiteralPath $instancePath -Raw -Encoding utf8 | ConvertFrom-Json
        if ([int]$instance.schema -ne 1 -or [int]$instance.pid -le 0) { throw 'invalid instance record' }
        $candidate = Get-Process -Id ([int]$instance.pid) -ErrorAction Stop
        $recordedStart = ([DateTime]::Parse([string]$instance.startedAt)).ToUniversalTime()
        $actualStart = $candidate.StartTime.ToUniversalTime()
        if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 10) {
            throw 'PID was reused'
        }
        return $candidate
    } catch {
        Remove-Item -LiteralPath $instancePath -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Sync-AgentProcessReference {
    if ($script:agentProcess -and -not $script:agentProcess.HasExited) { return $script:agentProcess }
    $script:agentProcess = Find-RegisteredAgentProcess
    return $script:agentProcess
}

function Read-AgentConfig {
    if (-not (Test-Path -LiteralPath $configPath)) { return $null }
    try { Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { $null }
}

function Save-AgentConfig {
    param($Config)
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    [System.IO.File]::WriteAllText(
        $configPath,
        ($Config | ConvertTo-Json -Depth 5),
        [System.Text.UTF8Encoding]::new($false))
}

function Convert-AgentServerToHttp {
    param([string]$Server)
    $uri = [Uri]$Server
    $builder = [UriBuilder]::new($uri)
    if ($builder.Scheme -eq 'ws') { $builder.Scheme = 'http' }
    elseif ($builder.Scheme -eq 'wss') { $builder.Scheme = 'https' }
    else { throw 'Адрес сервера должен начинаться с ws:// или wss://.' }
    $builder.Path = ''
    $builder.Query = ''
    $builder.Uri.AbsoluteUri.TrimEnd('/')
}

function Assert-SecureTransport {
    param([string]$Server)
    $uri = [Uri]$Server
    $loopback = $uri.Host -in @('localhost', '127.0.0.1', '::1')
    if ($uri.Scheme -eq 'ws' -and -not $loopback) {
        throw 'Передача пароля или токена по ws:// запрещена. Для удалённого сервера используйте только wss://.'
    }
}

function Assert-ValidNewPassword {
    param([AllowEmptyString()][string]$Password)
    $byteCount = [System.Text.Encoding]::UTF8.GetByteCount($Password)
    if ($Password.Length -lt 12 -or $Password.Length -gt 256 -or $byteCount -gt 1024 `
        -or $Password.Contains([char]0) -or $Password.Contains("`r") -or $Password.Contains("`n")) {
        throw 'Пароль должен содержать от 12 до 256 символов без переносов строк.'
    }
}

function Get-HubApiErrorMessage {
    param([System.Management.Automation.ErrorRecord]$ErrorRecord)
    try {
        $response = $ErrorRecord.Exception.Response
        if ($null -ne $response) {
            $stream = $response.GetResponseStream()
            if ($null -ne $stream) {
                $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)
                try { $payload = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
                switch ([string]$payload.code) {
                    'invalid_password' { return 'Пароль должен содержать от 12 до 256 символов без переносов строк.' }
                    'invalid_invite' { return 'Приглашение недействительно или уже использовано.' }
                    'expired_invite' { return 'Срок действия приглашения истёк.' }
                    'name_taken' { return 'Это имя участника уже зарегистрировано.' }
                    'invalid_credentials' { return 'Неверное имя участника или пароль.' }
                    'invalid_recovery_code' { return 'Код восстановления недействителен или уже использован.' }
                    'rate_limited' { return 'Слишком много попыток. Подождите и повторите вход.' }
                }
                if (-not [string]::IsNullOrWhiteSpace([string]$payload.error)) {
                    return [string]$payload.error
                }
            }
        }
    } catch {}
    [string]$ErrorRecord.Exception.Message
}

function Save-AuthenticatedSession($Result) {
    $credentialTarget = Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken'
    Set-EawHubCredential -Target $credentialTarget -UserName ([string]$Result.user.displayName) -Secret ([string]$Result.token)
    $nameBox.Text = [string]$Result.user.displayName
    Save-AgentConfig (Current-Config)
    $roles = @($Result.user.roles) -join ', '
    $status.Text = "Вход сохранён в Windows Credential Manager. Роли: $roles."
    Update-AgentStateView
}

function Invoke-HubAuthApi {
    param(
        [string]$Route,
        $Body = $null,
        [string]$Token = '',
        [string]$Method = 'Post'
    )
    $server = $serverBox.Text.Trim()
    Assert-SecureTransport -Server $server
    $parameters = @{
        Method = $Method
        Uri = (Convert-AgentServerToHttp $server) + $Route
        TimeoutSec = 5
    }
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json; charset=utf-8'
        $parameters.Body = ($Body | ConvertTo-Json)
    }
    if ($Token) { $parameters.Headers = @{ Authorization = 'Bearer ' + $Token } }
    try {
        Invoke-RestMethod @parameters
    } catch {
        throw (Get-HubApiErrorMessage -ErrorRecord $_)
    }
}

function Save-RecoveryCodeFile {
    param([string]$Code, [string]$DisplayName, [string]$Token)
    if ([string]::IsNullOrWhiteSpace($Code)) { return $false }
    [void][System.Windows.Forms.MessageBox]::Show(
        'Сейчас необходимо сохранить единственный код восстановления. Сервер и администратор не смогут показать его повторно.',
        'Код восстановления EaW Hub', 'OK', 'Warning')
    $dialog = [System.Windows.Forms.SaveFileDialog]::new()
    $safeName = ($DisplayName -replace '[<>:"/\\|?*]', '_')
    $dialog.FileName = "EaW-Hub-Recovery-$safeName.txt"
    $dialog.Filter = 'Текстовый файл (*.txt)|*.txt'
    $dialog.Title = 'Сохраните код восстановления EaW Hub'
    try {
        if ($dialog.ShowDialog($form) -ne [System.Windows.Forms.DialogResult]::OK) {
            [void](Invoke-HubAuthApi -Route '/api/auth/recovery/discard' -Token $Token -Body @{})
            return $false
        }
        $content = @"
EaW Localisation Hub – код восстановления

Пользователь: $DisplayName
Код: $Code

Храните этот файл отдельно и не отправляйте его другим людям.
Код одноразовый: после восстановления пароля потребуется новый.
Администратор и сервер не могут показать этот код повторно.
"@
        [System.IO.File]::WriteAllText($dialog.FileName, $content, [System.Text.UTF8Encoding]::new($false))
        [void](Invoke-HubAuthApi -Route '/api/auth/recovery/confirm' -Token $Token -Body @{ recoveryCode = $Code })
        return $true
    } catch {
        try { [void](Invoke-HubAuthApi -Route '/api/auth/recovery/discard' -Token $Token -Body @{}) } catch {}
        throw
    } finally {
        $dialog.Dispose()
        $content = $null
    }
}

function Show-ChangePasswordDialog {
    $credentialTarget = Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken'
    $credential = Get-EawHubCredential -Target $credentialTarget
    if (-not $credential -or [string]::IsNullOrWhiteSpace($credential.Secret)) {
        throw 'Сначала войдите в учётную запись.'
    }
    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = 'Изменение пароля EaW Hub'
    $dialog.Size = [System.Drawing.Size]::new(500, 325)
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $dialog.StartPosition = 'CenterParent'

    $notice = [System.Windows.Forms.Label]::new()
    $notice.Text = 'Используйте отдельный пароль только для этого сервера. После смены остальные активные сессии будут завершены.'
    $notice.ForeColor = [System.Drawing.Color]::DarkRed
    $notice.Location = [System.Drawing.Point]::new(20, 15)
    $notice.Size = [System.Drawing.Size]::new(445, 42)
    $dialog.Controls.Add($notice)

    $labels = @('Текущий пароль:', 'Новый пароль:', 'Повтор нового пароля:')
    $boxes = @()
    for ($index = 0; $index -lt 3; $index++) {
        $label = [System.Windows.Forms.Label]::new()
        $label.Text = $labels[$index]
        $label.AutoSize = $true
        $label.Location = [System.Drawing.Point]::new(20, (72 + 43 * $index))
        $dialog.Controls.Add($label)
        $box = [System.Windows.Forms.TextBox]::new()
        $box.UseSystemPasswordChar = $true
        $box.Location = [System.Drawing.Point]::new(190, (68 + 43 * $index))
        $box.Size = [System.Drawing.Size]::new(275, 24)
        $dialog.Controls.Add($box)
        $boxes += $box
    }

    $save = [System.Windows.Forms.Button]::new()
    $save.Text = 'Изменить'
    $save.Location = [System.Drawing.Point]::new(268, 215)
    $save.Size = [System.Drawing.Size]::new(95, 32)
    $dialog.Controls.Add($save)
    $cancel = [System.Windows.Forms.Button]::new()
    $cancel.Text = 'Отмена'
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.Location = [System.Drawing.Point]::new(370, 215)
    $cancel.Size = [System.Drawing.Size]::new(95, 32)
    $dialog.Controls.Add($cancel)
    $dialog.CancelButton = $cancel

    $save.Add_Click({
        try {
            if ($boxes[1].Text -cne $boxes[2].Text) { throw 'Новые пароли не совпадают.' }
            Assert-ValidNewPassword -Password $boxes[1].Text
            $result = Invoke-HubAuthApi -Route '/api/auth/password/change' -Token $credential.Secret -Body @{
                currentPassword = $boxes[0].Text
                newPassword = $boxes[1].Text
            }
            $boxes | ForEach-Object { $_.Clear() }
            $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $dialog.Close()
        } catch {
            $boxes | ForEach-Object { $_.Clear() }
            [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Пароль не изменён', 'OK', 'Warning')
        }
    })
    $changed = $dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK
    $boxes | ForEach-Object { $_.Clear() }
    $dialog.Dispose()
    $changed
}

function Quote-AgentArgument {
    param([string]$Value)
    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw 'Параметр Agent содержит недопустимую кавычку или перенос строки.'
    }
    '"' + $Value + '"'
}

function Get-NodeExecutable {
    $bundled = Join-Path $projectRoot 'node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    (Get-Command node.exe -ErrorAction Stop).Source
}

function Set-StartupShortcut {
    param([bool]$Enabled)
    $startup = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startup 'EaW Localisation Hub Agent.lnk'
    if (-not $Enabled) {
        Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
        return
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = (Get-Command powershell.exe -ErrorAction Stop).Source
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' +
        (Quote-AgentArgument $PSCommandPath) + ' -StartMinimized'
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.IconLocation = (Join-Path $projectRoot 'node.exe')
    $shortcut.Save()
}

function New-Label([string]$Text, [int]$X, [int]$Y) {
    $control = [System.Windows.Forms.Label]::new()
    $control.Text = $Text
    $control.AutoSize = $true
    $control.Location = [System.Drawing.Point]::new($X, $Y)
    $form.Controls.Add($control)
    $control
}

function New-TextBox([int]$X, [int]$Y, [int]$Width) {
    $control = [System.Windows.Forms.TextBox]::new()
    $control.Location = [System.Drawing.Point]::new($X, $Y)
    $control.Size = [System.Drawing.Size]::new($Width, 24)
    $form.Controls.Add($control)
    $control
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = [System.Windows.Forms.Form]::new()
$form.Text = "EaW Localisation Hub $($clientStatusMetadata.Version) – Desktop Agent"
$form.Size = [System.Drawing.Size]::new(720, 811)
$form.MinimumSize = [System.Drawing.Size]::new(720, 811)
$form.StartPosition = 'CenterScreen'

$title = New-Label 'Настройка Desktop Agent' 24 18
$title.Font = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)

New-Label 'Сервер WebSocket:' 27 66 | Out-Null
$serverBox = New-TextBox 195 62 475
New-Label 'Репозиторий EaW:' 27 105 | Out-Null
$repoBox = New-TextBox 195 101 395
$browseButton = [System.Windows.Forms.Button]::new()
$browseButton.Text = 'Обзор…'
$browseButton.Location = [System.Drawing.Point]::new(597, 100)
$browseButton.Size = [System.Drawing.Size]::new(73, 26)
$form.Controls.Add($browseButton)
New-Label 'Имя участника:' 27 144 | Out-Null
$nameBox = New-TextBox 195 140 250
New-Label 'Цвет:' 465 144 | Out-Null
$colorBox = New-TextBox 515 140 100
$colorPickerButton = [System.Windows.Forms.Button]::new()
$colorPickerButton.AccessibleName = 'Выбрать цвет участника'
$colorPickerButton.Location = [System.Drawing.Point]::new(622, 139)
$colorPickerButton.Size = [System.Drawing.Size]::new(48, 27)
$colorPickerButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$colorPickerButton.UseVisualStyleBackColor = $false
$form.Controls.Add($colorPickerButton)
$warning = [System.Windows.Forms.Label]::new()
$warning.Text = 'ВАЖНО: придумайте отдельный пароль только для этого сервера. Не используйте пароль от GitHub, Discord, почты, банка или любого другого сайта.'
$warning.ForeColor = [System.Drawing.Color]::DarkRed
$warning.Font = [System.Drawing.Font]::new('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$warning.Location = [System.Drawing.Point]::new(27, 177)
$warning.Size = [System.Drawing.Size]::new(643, 46)
$form.Controls.Add($warning)

New-Label 'Приглашение / код восстановления:' 27 239 | Out-Null
$inviteBox = New-TextBox 245 235 425
New-Label 'Пароль:' 27 278 | Out-Null
$passwordBox = New-TextBox 220 274 450
$passwordBox.UseSystemPasswordChar = $true
New-Label 'Повтор нового пароля:' 27 317 | Out-Null
$passwordConfirmBox = New-TextBox 220 313 450
$passwordConfirmBox.UseSystemPasswordChar = $true

$activateButton = [System.Windows.Forms.Button]::new()
$activateButton.Text = 'Регистрация по приглашению'
$activateButton.Location = [System.Drawing.Point]::new(27, 353)
$activateButton.Size = [System.Drawing.Size]::new(210, 34)
$form.Controls.Add($activateButton)
$loginButton = [System.Windows.Forms.Button]::new()
$loginButton.Text = 'Войти по паролю'
$loginButton.Location = [System.Drawing.Point]::new(247, 353)
$loginButton.Size = [System.Drawing.Size]::new(190, 34)
$form.Controls.Add($loginButton)
$resetPasswordButton = [System.Windows.Forms.Button]::new()
$resetPasswordButton.Text = 'Восстановить по коду'
$resetPasswordButton.Location = [System.Drawing.Point]::new(447, 353)
$resetPasswordButton.Size = [System.Drawing.Size]::new(180, 34)
$form.Controls.Add($resetPasswordButton)

$startupCheck = [System.Windows.Forms.CheckBox]::new()
$startupCheck.Text = 'Запускать Agent вместе с Windows'
$startupCheck.AutoSize = $true
$startupCheck.Location = [System.Drawing.Point]::new(27, 407)
$form.Controls.Add($startupCheck)

$trayModeCheck = [System.Windows.Forms.CheckBox]::new()
$trayModeCheck.Text = 'После закрытия оставлять в области уведомлений'
$trayModeCheck.AutoSize = $true
$trayModeCheck.Location = [System.Drawing.Point]::new(300, 407)
$form.Controls.Add($trayModeCheck)

$startButton = [System.Windows.Forms.Button]::new()
$startButton.Text = 'Запустить Agent'
$startButton.Location = [System.Drawing.Point]::new(27, 441)
$startButton.Size = [System.Drawing.Size]::new(190, 38)
$form.Controls.Add($startButton)
$stopButton = [System.Windows.Forms.Button]::new()
$stopButton.Text = 'Остановить Agent'
$stopButton.Location = [System.Drawing.Point]::new(228, 441)
$stopButton.Size = [System.Drawing.Size]::new(190, 38)
$form.Controls.Add($stopButton)
$logoutButton = [System.Windows.Forms.Button]::new()
$logoutButton.Text = 'Выйти и удалить токен'
$logoutButton.Location = [System.Drawing.Point]::new(429, 441)
$logoutButton.Size = [System.Drawing.Size]::new(210, 38)
$form.Controls.Add($logoutButton)
$changePasswordButton = [System.Windows.Forms.Button]::new()
$changePasswordButton.Text = 'Изменить мой пароль…'
$changePasswordButton.Location = [System.Drawing.Point]::new(429, 487)
$changePasswordButton.Size = [System.Drawing.Size]::new(210, 32)
$form.Controls.Add($changePasswordButton)

$stateGroup = [System.Windows.Forms.GroupBox]::new()
$stateGroup.Text = 'Состояние'
$stateGroup.Location = [System.Drawing.Point]::new(27, 529)
$stateGroup.Size = [System.Drawing.Size]::new(643, 128)
$form.Controls.Add($stateGroup)

$serverState = [System.Windows.Forms.Label]::new()
$serverState.Location = [System.Drawing.Point]::new(14, 25)
$serverState.Size = [System.Drawing.Size]::new(300, 22)
$stateGroup.Controls.Add($serverState)
$tokenState = [System.Windows.Forms.Label]::new()
$tokenState.Location = [System.Drawing.Point]::new(320, 25)
$tokenState.Size = [System.Drawing.Size]::new(305, 22)
$stateGroup.Controls.Add($tokenState)
$versionState = [System.Windows.Forms.Label]::new()
$versionState.Location = [System.Drawing.Point]::new(14, 51)
$versionState.Size = [System.Drawing.Size]::new(400, 22)
$stateGroup.Controls.Add($versionState)
$agentState = [System.Windows.Forms.Label]::new()
$agentState.Location = [System.Drawing.Point]::new(420, 51)
$agentState.Size = [System.Drawing.Size]::new(205, 22)
$stateGroup.Controls.Add($agentState)
$lastCheckState = [System.Windows.Forms.Label]::new()
$lastCheckState.ForeColor = [System.Drawing.Color]::DimGray
$lastCheckState.Location = [System.Drawing.Point]::new(14, 84)
$lastCheckState.Size = [System.Drawing.Size]::new(405, 25)
$stateGroup.Controls.Add($lastCheckState)
$checkStateButton = [System.Windows.Forms.Button]::new()
$checkStateButton.Text = 'Проверить сейчас'
$checkStateButton.Location = [System.Drawing.Point]::new(470, 80)
$checkStateButton.Size = [System.Drawing.Size]::new(155, 30)
$stateGroup.Controls.Add($checkStateButton)

$status = [System.Windows.Forms.Label]::new()
$status.Text = 'Для первого входа нужны приглашение и новый пароль; затем достаточно имени и пароля.'
$status.BorderStyle = 'FixedSingle'
$status.Location = [System.Drawing.Point]::new(27, 668)
$status.Size = [System.Drawing.Size]::new(643, 66)
$status.TextAlign = 'MiddleLeft'
$form.Controls.Add($status)

$tray = [System.Windows.Forms.NotifyIcon]::new()
$tray.Icon = [System.Drawing.SystemIcons]::Application
$tray.Text = 'EaW Localisation Hub Agent'
$tray.Visible = $true
$trayMenu = [System.Windows.Forms.ContextMenuStrip]::new()
$showTrayItem = $trayMenu.Items.Add('Открыть настройки')
$startTrayItem = $trayMenu.Items.Add('Запустить Agent')
$stopTrayItem = $trayMenu.Items.Add('Остановить Agent')
$trayMenu.Items.Add('-') | Out-Null
$exitTrayItem = $trayMenu.Items.Add('Закрыть Agent')
$tray.ContextMenuStrip = $trayMenu

$saved = Read-AgentConfig
$serverBox.Text = if ($saved.Server) { [string]$saved.Server } else { 'wss://eawhub.mooo.com:10443' }
$repoBox.Text = if ($saved.Repo) { [string]$saved.Repo } else { '' }
$nameBox.Text = if ($saved.User) { [string]$saved.User } else { '' }
$colorBox.Text = if ($saved.Color) { [string]$saved.Color } else { '#6aa9ff' }
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'EaW Localisation Hub Agent.lnk'
$startupCheck.Checked = Test-Path -LiteralPath $startupShortcut
$trayModeCheck.Checked = $saved.KeepInTray -eq $true

function Current-Config {
    [pscustomobject]@{
        Server = $serverBox.Text.Trim()
        Repo = $repoBox.Text.Trim()
        User = $nameBox.Text.Trim()
        Color = $colorBox.Text.Trim()
        KeepInTray = $trayModeCheck.Checked
    }
}

function Update-ColorPreview {
    if ($colorBox.Text.Trim() -match '^#[0-9A-Fa-f]{6}$') {
        $colorPickerButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml($colorBox.Text.Trim())
        $colorPickerButton.Text = ''
    } else {
        $colorPickerButton.BackColor = [System.Drawing.SystemColors]::Control
        $colorPickerButton.Text = '?'
    }
}

function Set-StateText {
    param($Control, [string]$Text, [System.Drawing.Color]$Color)
    $Control.Text = $Text
    $Control.ForeColor = $Color
}

function Update-AgentStateView {
    if ($script:checkingState) { return }
    $script:checkingState = $true
    $checkStateButton.Enabled = $false
    try {
        [void](Sync-AgentProcessReference)
        if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
            Set-StateText $agentState "Agent: запущен (PID $($script:agentProcess.Id))" ([System.Drawing.Color]::ForestGreen)
        } else {
            Set-StateText $agentState 'Agent: остановлен' ([System.Drawing.Color]::DimGray)
        }

        Set-StateText $serverState 'Сервер: проверка…' ([System.Drawing.Color]::DimGray)
        Set-StateText $versionState "Клиент: $($clientStatusMetadata.Version); сервер: проверка…" ([System.Drawing.Color]::DimGray)
        Set-StateText $tokenState 'Токен: проверка…' ([System.Drawing.Color]::DimGray)
        $form.Refresh()

        try {
            $health = Invoke-HubAuthApi -Route '/health' -Method Get
        } catch {
            Set-StateText $serverState 'Сервер: недоступен' ([System.Drawing.Color]::Firebrick)
            Set-StateText $versionState "Клиент: $($clientStatusMetadata.Version); обновление не проверено" ([System.Drawing.Color]::DarkOrange)
            Set-StateText $tokenState 'Токен: состояние неизвестно' ([System.Drawing.Color]::DarkOrange)
            $lastCheckState.Text = "Последняя проверка: $([DateTime]::Now.ToString('G'))"
            return
        }

        Set-StateText $serverState "Сервер: доступен ($($health.version))" ([System.Drawing.Color]::ForestGreen)
        $versionComparison = Compare-EawHubDisplayVersion `
            -Installed $clientStatusMetadata.Version -Recommended ([string]$health.version)
        if ([int]$health.protocol -ne $clientStatusMetadata.Protocol) {
            Set-StateText $versionState "Протокол несовместим: клиент $($clientStatusMetadata.Protocol), сервер $($health.protocol)" ([System.Drawing.Color]::Firebrick)
        } elseif ($null -eq $versionComparison) {
            Set-StateText $versionState "Версии: клиент $($clientStatusMetadata.Version), сервер $($health.version)" ([System.Drawing.Color]::DarkOrange)
        } elseif ($versionComparison -lt 0) {
            Set-StateText $versionState "Доступно обновление: $($clientStatusMetadata.Version) → $($health.version)" ([System.Drawing.Color]::DarkOrange)
        } elseif ($versionComparison -gt 0) {
            Set-StateText $versionState "Клиент $($clientStatusMetadata.Version); сервер требует обновления ($($health.version))" ([System.Drawing.Color]::SteelBlue)
        } else {
            Set-StateText $versionState "Версия актуальна: $($clientStatusMetadata.Version), протокол $($health.protocol)" ([System.Drawing.Color]::ForestGreen)
        }

        $credentialTarget = Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken'
        $credential = Get-EawHubCredential -Target $credentialTarget
        if (-not $credential -or [string]::IsNullOrWhiteSpace([string]$credential.Secret)) {
            Set-StateText $tokenState 'Токен: отсутствует' ([System.Drawing.Color]::DarkOrange)
        } else {
            try {
                $account = Invoke-HubAuthApi -Route '/api/auth/me' -Token $credential.Secret -Method Get
                if ($account.user.temporaryPassword) {
                    Set-StateText $tokenState 'Токен: действует; смените временный пароль' ([System.Drawing.Color]::DarkOrange)
                } else {
                    Set-StateText $tokenState "Токен: действует ($($account.user.displayName))" ([System.Drawing.Color]::ForestGreen)
                }
            } catch {
                Set-StateText $tokenState 'Токен: истёк или отозван – войдите снова' ([System.Drawing.Color]::Firebrick)
            }
        }
        $lastCheckState.Text = "Последняя проверка: $([DateTime]::Now.ToString('G'))"
    } finally {
        $checkStateButton.Enabled = $true
        $script:checkingState = $false
    }
}

function Stop-AgentProcess {
    [void](Sync-AgentProcessReference)
    if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
        Stop-Process -Id $script:agentProcess.Id -ErrorAction Stop
        $script:agentProcess.WaitForExit(3000) | Out-Null
    }
    $script:agentProcess = $null
    $status.Text = 'Desktop Agent остановлен.'
    Update-AgentStateView
}

function Start-AgentProcess {
    [void](Sync-AgentProcessReference)
    if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
        $status.Text = "Desktop Agent уже запущен (PID $($script:agentProcess.Id))."
        return
    }
    $config = Current-Config
    if (-not (Test-Path -LiteralPath $config.Repo -PathType Container)) { throw 'Выбранный репозиторий не найден.' }
    if ($config.Server -notmatch '^wss?://') { throw 'Адрес сервера должен начинаться с ws:// или wss://.' }
    Assert-SecureTransport -Server $config.Server
    if ($config.Color -notmatch '^#[0-9A-Fa-f]{6}$') { throw 'Цвет должен иметь вид #RRGGBB.' }
    $credentialTarget = Get-EawHubCredentialTarget -Server $config.Server -Kind 'AgentToken'
    $credential = Get-EawHubCredential -Target $credentialTarget
    if (-not $credential -or [string]::IsNullOrWhiteSpace($credential.Secret)) {
        throw 'Сначала зарегистрируйтесь или войдите.'
    }
    $account = Invoke-HubAuthApi -Route '/api/auth/me' -Token $credential.Secret -Method Get
    if ($account.user.temporaryPassword) {
        throw 'Сначала замените временный пароль на собственный постоянный пароль.'
    }
    Save-AgentConfig $config
    Set-StartupShortcut -Enabled $startupCheck.Checked
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $arguments = @(
        (Join-Path $projectRoot 'apps\agent\src\main.mjs'),
        '--repo', $config.Repo,
        '--server', $config.Server,
        '--user', $config.User,
        '--color', $config.Color,
        '--state', $stateDirectory
    )
    $argumentLine = ($arguments | ForEach-Object { Quote-AgentArgument ([string]$_) }) -join ' '
    $previousToken = $env:EAW_HUB_TOKEN
    $previousIpcSecret = $env:EAW_HUB_IPC_SECRET
    try {
        $env:EAW_HUB_TOKEN = $credential.Secret
        $env:EAW_HUB_IPC_SECRET = Get-OrCreate-EawHubIpcSecret
        $script:agentProcess = Start-Process -FilePath (Get-NodeExecutable) `
            -ArgumentList $argumentLine `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logDirectory 'agent.out.log') `
            -RedirectStandardError (Join-Path $logDirectory 'agent.err.log') `
            -PassThru
        Start-Sleep -Milliseconds 350
        if ($script:agentProcess.HasExited) {
            $exitCode = $script:agentProcess.ExitCode
            $script:agentProcess = Find-RegisteredAgentProcess
            if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
                throw "Обнаружен уже работающий Desktop Agent (PID $($script:agentProcess.Id))."
            }
            throw "Desktop Agent завершился при запуске с кодом $exitCode. Проверьте журнал: $logDirectory"
        }
    }
    finally {
        if ($null -eq $previousToken) { Remove-Item Env:EAW_HUB_TOKEN -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_TOKEN = $previousToken }
        if ($null -eq $previousIpcSecret) { Remove-Item Env:EAW_HUB_IPC_SECRET -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_IPC_SECRET = $previousIpcSecret }
    }
    $status.Text = "Desktop Agent запущен (PID $($script:agentProcess.Id)). Токен получен из Windows Credential Manager."
    Update-AgentStateView
}

$colorTip = [System.Windows.Forms.ToolTip]::new()
$colorTip.SetToolTip($colorPickerButton, 'Выбрать цвет участника')
$colorBox.Add_TextChanged({ Update-ColorPreview })
$colorPickerButton.Add_Click({
    $dialog = [System.Windows.Forms.ColorDialog]::new()
    $dialog.AllowFullOpen = $true
    $dialog.AnyColor = $true
    $dialog.FullOpen = $true
    $dialog.SolidColorOnly = $true
    if ($colorBox.Text.Trim() -match '^#[0-9A-Fa-f]{6}$') {
        $dialog.Color = [System.Drawing.ColorTranslator]::FromHtml($colorBox.Text.Trim())
    }
    try {
        if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
            $colorBox.Text = '#{0:X2}{1:X2}{2:X2}' -f $dialog.Color.R, $dialog.Color.G, $dialog.Color.B
        }
    } finally {
        $dialog.Dispose()
    }
})
Update-ColorPreview

$browseButton.Add_Click({
    $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = 'Выберите корень локального репозитория EaW'
    if ($repoBox.Text -and (Test-Path -LiteralPath $repoBox.Text)) { $dialog.SelectedPath = $repoBox.Text }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $repoBox.Text = $dialog.SelectedPath }
})

$activateButton.Add_Click({
    try {
        $activateButton.Enabled = $false
        $status.Text = 'Проверка приглашения…'
        $form.Refresh()
        if ($passwordBox.Text -cne $passwordConfirmBox.Text) { throw 'Пароли не совпадают.' }
        Assert-ValidNewPassword -Password $passwordBox.Text
        $result = Invoke-HubAuthApi -Route '/api/auth/redeem' -Body @{
            inviteCode = $inviteBox.Text.Trim()
            displayName = $nameBox.Text.Trim()
            password = $passwordBox.Text
        }
        Save-AuthenticatedSession $result
        if (-not (Save-RecoveryCodeFile -Code ([string]$result.recoveryCode) `
            -DisplayName ([string]$result.user.displayName) -Token ([string]$result.token))) {
            $status.Text = 'Аккаунт создан, но код восстановления не сохранён. В Review будет постоянно показано предупреждение.'
        }
        $inviteBox.Clear()
    }
    catch {
        $status.Text = "Не удалось зарегистрироваться: $($_.Exception.Message)"
    }
    finally {
        $passwordBox.Clear()
        $passwordConfirmBox.Clear()
        $activateButton.Enabled = $true
    }
})

$loginButton.Add_Click({
    try {
        $loginButton.Enabled = $false
        $status.Text = 'Проверка имени и пароля…'
        $form.Refresh()
        $result = Invoke-HubAuthApi -Route '/api/auth/login' -Body @{
            displayName = $nameBox.Text.Trim()
            password = $passwordBox.Text
        }
        Save-AuthenticatedSession $result
        if ($result.user.temporaryPassword) {
            $status.Text = 'Выполнен вход по временному паролю. Замените его перед запуском Agent.'
            [void][System.Windows.Forms.MessageBox]::Show(
                'Администратор установил временный пароль. Сейчас задайте собственный постоянный пароль.',
                'Требуется смена пароля', 'OK', 'Warning')
            [void](Show-ChangePasswordDialog)
        }
    } catch {
        $status.Text = "Не удалось войти: $($_.Exception.Message)"
    } finally {
        $passwordBox.Clear()
        $passwordConfirmBox.Clear()
        $loginButton.Enabled = $true
    }
})

$resetPasswordButton.Add_Click({
    try {
        $resetPasswordButton.Enabled = $false
        if ($passwordBox.Text -cne $passwordConfirmBox.Text) { throw 'Пароли не совпадают.' }
        Assert-ValidNewPassword -Password $passwordBox.Text
        $status.Text = 'Проверка одноразового кода восстановления…'
        $form.Refresh()
        $result = Invoke-HubAuthApi -Route '/api/auth/password/recover' -Body @{
            displayName = $nameBox.Text.Trim()
            recoveryCode = $inviteBox.Text.Trim()
            newPassword = $passwordBox.Text
        }
        Save-AuthenticatedSession $result
        $inviteBox.Clear()
    } catch {
        $status.Text = "Не удалось восстановить пароль: $($_.Exception.Message)"
    } finally {
        $passwordBox.Clear()
        $passwordConfirmBox.Clear()
        $resetPasswordButton.Enabled = $true
    }
})

$startButton.Add_Click({ try { Start-AgentProcess } catch { $status.Text = "Ошибка запуска: $($_.Exception.Message)" } })
$stopButton.Add_Click({ try { Stop-AgentProcess } catch { $status.Text = "Ошибка остановки: $($_.Exception.Message)" } })
$logoutButton.Add_Click({
    $remoteStatus = ''
    $credentialTarget = Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken'
    try {
        Stop-AgentProcess
        $credential = Get-EawHubCredential -Target $credentialTarget
        if ($credential -and -not [string]::IsNullOrWhiteSpace($credential.Secret)) {
            try {
                [void](Invoke-HubAuthApi -Route '/api/auth/logout' -Token $credential.Secret -Body @{})
            } catch { $remoteStatus = ' Сервер недоступен, поэтому удалён только локальный токен.' }
        }
    } finally {
        Remove-EawHubCredential -Target $credentialTarget
        $status.Text = 'Выход выполнен, токен удалён из Windows Credential Manager.' + $remoteStatus
        Update-AgentStateView
    }
})
$changePasswordButton.Add_Click({
    try {
        if (Show-ChangePasswordDialog) {
            $status.Text = 'Пароль изменён. Текущая сессия сохранена, остальные завершены.'
        }
    } catch { $status.Text = "Не удалось изменить пароль: $($_.Exception.Message)" }
})
$startupCheck.Add_CheckedChanged({
    try { Set-StartupShortcut -Enabled $startupCheck.Checked } catch { $status.Text = "Не удалось изменить автозапуск: $($_.Exception.Message)" }
})
$trayModeCheck.Add_CheckedChanged({ Save-AgentConfig (Current-Config) })
$checkStateButton.Add_Click({ Update-AgentStateView })

$showTrayItem.Add_Click({ $form.Show(); $form.WindowState = 'Normal'; $form.Activate() })
$tray.Add_DoubleClick({ $form.Show(); $form.WindowState = 'Normal'; $form.Activate() })
$startTrayItem.Add_Click({ try { Start-AgentProcess } catch { $tray.ShowBalloonTip(4000, 'EaW Hub', $_.Exception.Message, 'Error') } })
$stopTrayItem.Add_Click({ try { Stop-AgentProcess } catch {} })
$exitTrayItem.Add_Click({
    $script:allowExit = $true
    try { Stop-AgentProcess } catch {}
    $tray.Visible = $false
    $form.Close()
})
$form.Add_FormClosing({
    param($sender, $eventArgs)
    if (-not $script:allowExit -and $trayModeCheck.Checked) {
        $eventArgs.Cancel = $true
        $form.Hide()
        $tray.ShowBalloonTip(2500, 'EaW Hub', 'Desktop Agent продолжает работать в области уведомлений.', 'Info')
    } elseif (-not $script:allowExit) {
        $script:allowExit = $true
        try { Stop-AgentProcess } catch {}
        $tray.Visible = $false
    }
})

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 1000
$timer.Add_Tick({
    if ($script:agentProcess -and $script:agentProcess.HasExited) {
        $exitCode = $script:agentProcess.ExitCode
        $script:agentProcess = $null
        $status.Text = "Desktop Agent завершился с кодом $exitCode. Проверьте журнал: $logDirectory"
    }
})
$timer.Start()

$stateTimer = [System.Windows.Forms.Timer]::new()
$stateTimer.Interval = 15000
$stateTimer.Add_Tick({ Update-AgentStateView })
$stateTimer.Start()
Update-AgentStateView

if ($StartMinimized) {
    $form.Add_Shown({
        $form.Hide()
        try { Start-AgentProcess } catch { $tray.ShowBalloonTip(5000, 'EaW Hub – ошибка запуска', $_.Exception.Message, 'Error') }
    })
}
[void]$form.ShowDialog()
$timer.Stop()
$stateTimer.Stop()
$tray.Dispose()
