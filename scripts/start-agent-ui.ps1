param([switch]$StartMinimized)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'credential-store.ps1')
. (Join-Path $PSScriptRoot 'repository-sync-ui.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'agent-status.ps1')
$clientStatusMetadata = Get-EawHubClientStatusMetadata -ProjectRoot $projectRoot
$stateDirectory = Join-Path $env:LOCALAPPDATA 'EaWLocalisationHub'
$configPath = Join-Path $stateDirectory 'agent-config.json'
$instancePath = Join-Path $stateDirectory 'agent-instance.json'
$logDirectory = Join-Path $stateDirectory 'logs'
$script:agentProcess = $null
$script:allowExit = $false
$script:lastUpdateStatusStamp = ''
$script:uiStartedAtUtc = [DateTime]::UtcNow
$script:lastUpdateCheckAt = [DateTime]::MinValue
$script:clientUpdateProcess = $null
$script:repositorySyncStatus = $null
$script:seenRepositoryAlerts = @{}

function Start-ClientUpdateCheck {
    param([switch]$Install)
    if ($script:clientUpdateProcess -and -not $script:clientUpdateProcess.HasExited) { return }
    if (-not $Install -and ([DateTime]::UtcNow - $script:lastUpdateCheckAt).TotalMinutes -lt 5) { return }
    $updater = Join-Path $PSScriptRoot 'update-client.ps1'
    if (-not (Test-Path -LiteralPath $updater -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $projectRoot 'review\EaWReview.exe') -PathType Leaf)) {
        if ($Install) { throw 'Обновление доступно только для установленного клиента, не для исходников.' }
        return
    }
    $script:lastUpdateCheckAt = [DateTime]::UtcNow
    $ownerStartedAtTicks = [System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' +
        (Quote-AgentArgument $updater) + ' -ProjectRoot ' + (Quote-AgentArgument $projectRoot) +
        " -OwnerProcessId $PID -OwnerStartedAtTicks $ownerStartedAtTicks"
    if ($Install) { $arguments += ' -Install' }
    $script:clientUpdateProcess = Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
        -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    $updateClientButton.Enabled = $false
    if ($Install) { $status.Text = 'Проверяем релизы GitHub. Скачивание и установка начнутся, если есть новая версия…' }
}

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
$form.Size = [System.Drawing.Size]::new(720, [Math]::Min(947, [Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height - 40))
$form.MinimumSize = [System.Drawing.Size]::new(720, 640)
$form.AutoScroll = $true
$form.AutoScrollMinSize = [System.Drawing.Size]::new(690, 908)
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
$reviewButton = [System.Windows.Forms.Button]::new()
$reviewButton.Text = 'Запустить Review'
$reviewButton.Location = [System.Drawing.Point]::new(27, 487)
$reviewButton.Size = [System.Drawing.Size]::new(391, 32)
$reviewButton.Enabled = $false
$form.Controls.Add($reviewButton)
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
$lastCheckState.Size = [System.Drawing.Size]::new(288, 25)
$stateGroup.Controls.Add($lastCheckState)
$checkStateButton = [System.Windows.Forms.Button]::new()
$checkStateButton.Text = 'Проверить сейчас'
$checkStateButton.Location = [System.Drawing.Point]::new(470, 80)
$checkStateButton.Size = [System.Drawing.Size]::new(155, 30)
$stateGroup.Controls.Add($checkStateButton)
$updateClientButton = [System.Windows.Forms.Button]::new()
$updateClientButton.Text = 'Обновить клиент…'
$updateClientButton.Location = [System.Drawing.Point]::new(308, 80)
$updateClientButton.Size = [System.Drawing.Size]::new(155, 30)
$stateGroup.Controls.Add($updateClientButton)

$status = [System.Windows.Forms.Label]::new()
$status.Text = 'Для первого входа нужны приглашение и новый пароль; затем достаточно имени и пароля.'
$status.BorderStyle = 'FixedSingle'
$status.Location = [System.Drawing.Point]::new(27, 830)
$status.Size = [System.Drawing.Size]::new(643, 66)
$status.TextAlign = 'MiddleLeft'
$form.Controls.Add($status)

$repositoryGroup = [System.Windows.Forms.GroupBox]::new()
$repositoryGroup.Text = 'Git — текущая ветка репозитория (не обновление клиента)'
$repositoryGroup.Location = [System.Drawing.Point]::new(27, 665)
$repositoryGroup.Size = [System.Drawing.Size]::new(643, 156)
$form.Controls.Add($repositoryGroup)
$repositoryState = [System.Windows.Forms.Label]::new()
$repositoryState.Location = [System.Drawing.Point]::new(14, 21)
$repositoryState.Size = [System.Drawing.Size]::new(612, 67)
$repositoryGroup.Controls.Add($repositoryState)
$repositoryTiming = [System.Windows.Forms.Label]::new()
$repositoryTiming.Location = [System.Drawing.Point]::new(14, 88)
$repositoryTiming.Size = [System.Drawing.Size]::new(612, 22)
$repositoryTiming.ForeColor = [Drawing.Color]::DimGray
$repositoryGroup.Controls.Add($repositoryTiming)
$repositoryButtons = @{}
$buttonSpecs = @(
    @('details', 'Подробнее', 14, 95),
    @('check', 'Проверить снова', 116, 135),
    @('update', 'Обновить репозиторий сейчас', 258, 215),
    @('settings', 'Настройки Git…', 480, 145)
)
foreach ($spec in $buttonSpecs) {
    $button = [System.Windows.Forms.Button]::new()
    $button.Text = $spec[1]; $button.Location = [System.Drawing.Point]::new([int]$spec[2], 116)
    $button.Size = [System.Drawing.Size]::new([int]$spec[3], 28)
    $repositoryGroup.Controls.Add($button); $repositoryButtons[$spec[0]] = $button
}

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

function Update-RepositorySyncTiming {
    $text = if ($script:repositorySyncStatus) { Get-EawRepositorySyncTiming $script:repositorySyncStatus } else { '' }
    if ($repositoryTiming.Text -cne $text) { $repositoryTiming.Text = $text }
}

function Update-RepositorySyncView {
    $script:repositorySyncStatus = $null
    $buttonsEnabled = $false
    $stateText = 'Git: выберите корректный репозиторий EaW.'
    $stateColor = [Drawing.Color]::DimGray
    try {
        $directory = Get-EawRepositorySyncDirectory $stateDirectory $repoBox.Text.Trim()
        $settings = Get-EawRepositorySyncSettings $directory
        $automationText = 'Авто-fetch: ' + $(if ($settings.autoFetch -or $settings.autoPull) { 'вкл.' } else { 'выкл.' }) +
            '; автообновление ветки: ' + $(if ($settings.autoPull) { 'вкл.' } else { 'выкл.' })
        $stateText = $automationText + "`r`nЗапустите Agent для работы с Git."
        $agent = Sync-AgentProcessReference
        if (-not $agent -or $agent.HasExited) { return }
        $value = Read-EawRepositorySyncJson (Join-Path $directory 'status.json')
        if (-not (Test-EawRepositorySyncStatus $value $agent.Id $repoBox.Text.Trim())) { return }
        $script:repositorySyncStatus = $value
        $busy = $value.stage -in @('checking', 'fetching', 'updating')
        $buttonsEnabled = -not $busy
        $counts = $(if ($null -ne $value.behind) { " | новых коммитов: $($value.behind)" } else { '' })
        $stateText = "$automationText`r`n$($value.branch)$counts`r`n$($value.message)"
        if ($value.stage -eq 'blocked' -and [int]$value.behind -gt 0) { $stateColor = [Drawing.Color]::Firebrick }
        elseif ($value.stage -in @('current', 'updated')) { $stateColor = [Drawing.Color]::ForestGreen }
        elseif ($value.stage -eq 'error') { $stateColor = [Drawing.Color]::DarkOrange }
        if ($value.alertId -and -not $script:seenRepositoryAlerts.ContainsKey([string]$value.alertId)) {
            $script:seenRepositoryAlerts[[string]$value.alertId] = $true
            Show-EawRepositorySyncAlert $form $tray $settings "Ветка $($value.branch): новых коммитов — $($value.behind). $($value.message)"
        }
    } catch {
        $script:repositorySyncStatus = $null
        $buttonsEnabled = $false
        $stateText = 'Git: выберите корректный репозиторий EaW.'
        $stateColor = [Drawing.Color]::DimGray
    } finally {
        # Commit the final view once, without clearing/repainting it on every tick.
        if ($repositoryState.Text -cne $stateText) { $repositoryState.Text = $stateText }
        if ($repositoryState.ForeColor -ne $stateColor) { $repositoryState.ForeColor = $stateColor }
        foreach ($name in @('check', 'update')) {
            if ($repositoryButtons[$name].Enabled -ne $buttonsEnabled) { $repositoryButtons[$name].Enabled = $buttonsEnabled }
        }
        Update-RepositorySyncTiming
    }
}

$repositoryButtons['settings'].Add_Click({
    try {
        $directory = Get-EawRepositorySyncDirectory $stateDirectory $repoBox.Text.Trim()
        Show-EawRepositorySyncSettings $form $directory
        Update-RepositorySyncView
    } catch { $status.Text = "Ошибка настроек Git: $($_.Exception.Message)" }
})
$repositoryButtons['details'].Add_Click({
    $value = $script:repositorySyncStatus
    $message = if ($value) {
        "Репозиторий: $($value.repository)`r`nВетка: $($value.branch)`r`nUpstream: $($value.upstream)`r`nНовых коммитов: $($value.behind); локальных: $($value.ahead)`r`n$(Get-EawRepositorySyncTiming $value)`r`n`r`n$($value.message)"
    } else { $repositoryState.Text }
    [void][Windows.Forms.MessageBox]::Show($form, $message, 'Состояние Git', 'OK', 'Information')
})
function Send-RepositorySyncRequest {
    param([ValidateSet('check', 'update')][string]$Action)
    Update-RepositorySyncView
    if (-not $script:repositorySyncStatus) { throw 'Запустите Agent с выбранным репозиторием.' }
    $directory = Get-EawRepositorySyncDirectory $stateDirectory $repoBox.Text.Trim()
    Request-EawRepositorySync $directory $script:agentProcess.Id $Action
    $repositoryButtons['check'].Enabled = $false; $repositoryButtons['update'].Enabled = $false
    $repositoryState.Text = 'Запрос отправлен Agent…'
}
$repositoryButtons['check'].Add_Click({
    try { Send-RepositorySyncRequest 'check' } catch { $status.Text = $_.Exception.Message }
})
$repositoryButtons['update'].Add_Click({
    $answer = [Windows.Forms.MessageBox]::Show($form,
        'Проверить remote и обновить текущую ветку до upstream? Только fast-forward и только при чистом рабочем каталоге. Локальные изменения не удаляются и не прячутся в stash.',
        'Обновить Git-репозиторий', 'YesNo', 'Question', 'Button2')
    if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }
    try { Send-RepositorySyncRequest 'update' } catch { $status.Text = $_.Exception.Message }
})

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
            $reviewButton.Enabled = $true
        } else {
            Set-StateText $agentState 'Agent: остановлен' ([System.Drawing.Color]::DimGray)
            $reviewButton.Enabled = $false
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
            try { Start-ClientUpdateCheck } catch { $status.Text = "Ошибка проверки обновления: $($_.Exception.Message)" }
        } elseif ($null -eq $versionComparison) {
            Set-StateText $versionState "Версии: клиент $($clientStatusMetadata.Version), сервер $($health.version)" ([System.Drawing.Color]::DarkOrange)
        } elseif ($versionComparison -lt 0) {
            Set-StateText $versionState "Доступно обновление: $($clientStatusMetadata.Version) → $($health.version)" ([System.Drawing.Color]::DarkOrange)
            try { Start-ClientUpdateCheck } catch { $status.Text = "Ошибка проверки обновления: $($_.Exception.Message)" }
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
    try {
        $env:EAW_HUB_TOKEN = $credential.Secret
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
$reviewButton.Add_Click({
    try {
        $reviewButton.Enabled = $false
        $status.Text = 'Открытие Review…'
        $form.Refresh()
        & (Join-Path $PSScriptRoot 'start-hub.ps1')
        $status.Text = 'Review запущен.'
    } catch {
        $status.Text = "Ошибка запуска Review: $($_.Exception.Message)"
    } finally {
        [void](Sync-AgentProcessReference)
        $reviewButton.Enabled = $script:agentProcess -and -not $script:agentProcess.HasExited
    }
})
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
$checkStateButton.Add_Click({
    Update-AgentStateView
    try { Start-ClientUpdateCheck } catch { $status.Text = "Ошибка проверки обновления: $($_.Exception.Message)" }
})
$updateClientButton.Add_Click({
    $answer = [System.Windows.Forms.MessageBox]::Show($form,
        'Скачать и установить новую версию с GitHub Releases? Если обновление найдено, Agent и Review будут закрыты на время установки, затем запущены снова. Windows может запросить права администратора. Без вашего подтверждения клиент не обновляется.',
        'Обновление EaW Localisation Hub', 'YesNo', 'Question', 'Button2')
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    try { Start-ClientUpdateCheck -Install } catch { $status.Text = "Не удалось запустить обновление: $($_.Exception.Message)" }
})

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
    Update-RepositorySyncView
    if ($script:clientUpdateProcess -and $script:clientUpdateProcess.HasExited) {
        $script:clientUpdateProcess.Dispose()
        $script:clientUpdateProcess = $null
        $updateClientButton.Enabled = $true
    }
    $updateStatusPath = Join-Path $stateDirectory 'update-status.json'
    if (Test-Path -LiteralPath $updateStatusPath -PathType Leaf) {
        try {
            $updateStatus = Get-Content -LiteralPath $updateStatusPath -Raw -Encoding utf8 | ConvertFrom-Json
            if ($updateStatus.UpdatedAt -ne $script:lastUpdateStatusStamp) {
                $script:lastUpdateStatusStamp = [string]$updateStatus.UpdatedAt
                $updateAtUtc = [DateTime]::Parse(
                    [string]$updateStatus.UpdatedAt,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
                if ($updateAtUtc -ge $script:uiStartedAtUtc -and
                    ($updateStatus.Stage -eq 'available' -or $updateStatus.InstallRequested) -and
                    $updateStatus.Stage -in @('checking', 'available', 'current', 'downloading', 'verifying', 'installing', 'switching', 'restarting', 'complete', 'error')) {
                    $status.Text = [string]$updateStatus.Message
                    if ($updateStatus.Stage -eq 'error' -and $updateStatus.InstallRequested) {
                        $tray.ShowBalloonTip(5000, 'EaW Hub – ошибка обновления', [string]$updateStatus.Message, 'Error')
                    }
                }
            }
        } catch {}
    }
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

$updateTimer = [System.Windows.Forms.Timer]::new()
$updateTimer.Interval = 15 * 60 * 1000
$updateTimer.Add_Tick({ try { Start-ClientUpdateCheck } catch { $status.Text = "Ошибка проверки обновления: $($_.Exception.Message)" } })
$updateTimer.Start()
$form.Add_Shown({ try { Start-ClientUpdateCheck } catch { $status.Text = "Ошибка проверки обновления: $($_.Exception.Message)" } })

if ($StartMinimized) {
    $form.Add_Shown({
        $form.Hide()
        try { Start-AgentProcess } catch { $tray.ShowBalloonTip(5000, 'EaW Hub – ошибка запуска', $_.Exception.Message, 'Error') }
    })
}
[void]$form.ShowDialog()
$timer.Stop()
$stateTimer.Stop()
$updateTimer.Stop()
$tray.Dispose()
