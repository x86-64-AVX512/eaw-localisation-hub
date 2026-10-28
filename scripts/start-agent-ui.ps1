param([switch]$StartMinimized)
. (Join-Path $PSScriptRoot 'ui-language.ps1')


$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'credential-store.ps1')
. (Join-Path $PSScriptRoot 'repository-sync-ui.ps1')
. (Join-Path $PSScriptRoot 'agent-network.ps1')
$uiNetwork = @{Checking=$false;Account=$null;AccountServer='';StartIntent=$null}

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
        if ($Install) { throw (Get-EawUiText -Text 'Обновление доступно только для установленного клиента, не для исходников.') }
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
    if ($Install) { $status.Text = (Get-EawUiText -Text 'Проверяем релизы GitHub. Скачивание и установка начнутся, если есть новая версия…') }
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
    else { throw (Get-EawUiText -Text 'Адрес сервера должен начинаться с ws:// или wss://.') }
    $builder.Path = ''
    $builder.Query = ''
    $builder.Uri.AbsoluteUri.TrimEnd('/')
}

function Assert-SecureTransport {
    param([string]$Server)
    $uri = [Uri]$Server
    $loopback = $uri.Host -in @('localhost', '127.0.0.1', '::1')
    if ($uri.Scheme -eq 'ws' -and -not $loopback) {
        throw (Get-EawUiText -Text 'Передача пароля или токена по ws:// запрещена. Для удалённого сервера используйте только wss://.')
    }
}

function Assert-ValidNewPassword {
    param([AllowEmptyString()][string]$Password)
    $byteCount = [System.Text.Encoding]::UTF8.GetByteCount($Password)
    if ($Password.Length -lt 12 -or $Password.Length -gt 256 -or $byteCount -gt 1024 `
        -or $Password.Contains([char]0) -or $Password.Contains("`r") -or $Password.Contains("`n")) {
        throw (Get-EawUiText -Text 'Пароль должен содержать от 12 до 256 символов без переносов строк.')
    }
}

function Get-HubApiErrorMessage {
    param($Result,$Payload)
    if ($Result.NetworkError) { return (Get-EawUiText -Text 'Не удалось получить ответ сервера. Состояние операции не подтверждено.') }
    switch ([string]$Payload.code) {
        'invalid_password' { return (Get-EawUiText -Text 'Пароль должен содержать от 12 до 256 символов без переносов строк.') }
        'invalid_invite' { return (Get-EawUiText -Text 'Приглашение недействительно или уже использовано.') }
        'expired_invite' { return (Get-EawUiText -Text 'Срок действия приглашения истёк.') }
        'name_taken' { return (Get-EawUiText -Text 'Это имя участника уже зарегистрировано.') }
        'invalid_credentials' { return (Get-EawUiText -Text 'Неверное имя участника или пароль.') }
        'invalid_recovery_code' { return (Get-EawUiText -Text 'Код восстановления недействителен или уже использован.') }
        'rate_limited' { return (Get-EawUiText -Text 'Слишком много попыток. Подождите и повторите вход.') }
    }
    if ($Payload.error) { return (Get-EawUiMessage ([string]$Payload.error)) }
    return "HTTP $($Result.Status)"
}

function Save-AuthenticatedSession($Result) {
    Cancel-AgentStart
    $uiNetwork.ConfirmedAt=[DateTime]::Now
    $credentialTarget = Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken'
    Set-EawHubCredential -Target $credentialTarget -UserName ([string]$Result.user.displayName) -Secret ([string]$Result.token)
    $nameBox.Text = [string]$Result.user.displayName
    Save-AgentConfig (Current-Config)
    $roles = @($Result.user.roles) -join ', '
    $status.Text = (Get-EawUiText -Text 'Вход сохранён в Windows Credential Manager. Роли: {0}.' -Values @($roles))
    Update-AgentStateView
}

function Invoke-HubAuthApi {
    param([string]$Route,$Body=$null,[string]$Token='',[string]$Method='POST',[string]$Key='account-action',
          [scriptblock]$Success,[scriptblock]$Failure,[scriptblock]$Complete,[string]$Operation='')
    $server=$serverBox.Text.Trim();Assert-SecureTransport -Server $server
    if (-not $Failure) { $Failure={param($result,$payload) $status.Text=Get-HubApiErrorMessage $result $payload} }
    $detached=$null
    if ($Operation) {
        $detached={
            param($result,$payload,$originalServer)
            if ($result.NetworkError) {
                $message=Get-EawUiText -Text 'Результат не подтверждён. Проверьте состояние перед повтором.'
            } elseif ($result.Status -ge 200 -and $result.Status -lt 300) {
                $message=Get-EawUiText -Text 'Операция выполнена.'
            } else {
                $message=Get-HubApiErrorMessage $result $payload
            }
            $status.Text=Get-EawUiText -Text 'Сервер {0}. {1}: {2}' -Values @($originalServer,(Get-EawUiText -Text $Operation),$message)
        }.GetNewClosure()
    }
    Start-EawAgentRequest -Key $Key -Server $server -Url ((Convert-AgentServerToHttp $server)+$Route) -Method $Method -Body $Body -Token $Token -Success $Success -Failure $Failure -Complete $Complete -DetachedResult $detached
}

function Cancel-AgentStart {
    # Also invalidate a callback already dequeued by a reentrant UI timer.
    $uiNetwork.StartIntent=$null
    Stop-EawAgentRequests -Keys @('start-check')
}

function Set-AccountActionBusy([bool]$Busy) {
    foreach($button in @($activateButton,$loginButton,$resetPasswordButton,$changePasswordButton,$logoutButton)) { $button.Enabled=-not $Busy }
}

function Save-RecoveryCodeFile {
    param([string]$Code,[string]$DisplayName,[string]$Token)
    if ([string]::IsNullOrWhiteSpace($Code)) {return $false}
    [void][Windows.Forms.MessageBox]::Show((Get-EawUiText -Text 'Сейчас необходимо сохранить единственный код восстановления. Сервер и администратор не смогут показать его повторно.'),(Get-EawUiText -Text 'Код восстановления EaW Hub'),'OK','Warning')
    $dialog=[Windows.Forms.SaveFileDialog]::new()
    $dialog.FileName='EaW-Hub-Recovery-'+($DisplayName -replace '[<>:"/\\|?*]','_')+'.txt'
    $dialog.Filter=Get-EawUiText -Text 'Текстовый файл (*.txt)|*.txt'
    try {
        if($dialog.ShowDialog($form) -ne [Windows.Forms.DialogResult]::OK) {
            [void](Invoke-HubAuthApi -Key 'recovery-code' -Route '/api/auth/recovery/discard' -Token $Token -Body @{})
            return $false
        }
        $content=Get-EawUiText -Text 'EaW Localisation Hub – код восстановления

Пользователь: {0}
Код: {1}

Храните этот файл отдельно и не отправляйте его другим людям.
Код одноразовый: после восстановления пароля потребуется новый.
Администратор и сервер не могут показать этот код повторно.
' -Values @($DisplayName,$Code)
        [IO.File]::WriteAllText($dialog.FileName,$content,[Text.UTF8Encoding]::new($false))
        [void](Invoke-HubAuthApi -Key 'recovery-code' -Route '/api/auth/recovery/confirm' -Token $Token -Body @{recoveryCode=$Code} -Success {
            $status.Text=Get-EawUiText -Text 'Код восстановления сохранён и подтверждён.';Update-AgentStateView
        } -Failure {
            $status.Text=Get-EawUiText -Text 'Файл кода сохранён, но подтверждение сервера не получено. Проверьте состояние в Review.'
        })
        return $true
    } finally {$dialog.Dispose();$content=$null}
}

function Show-ChangePasswordDialog {
    if ($script:agentRequests.ContainsKey('password-change')) {
        throw (Get-EawUiText -Text 'Дождитесь завершения предыдущего запроса смены пароля.')
    }
    $credentialTarget = Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken'
    $credential = Get-EawHubCredential -Target $credentialTarget
    if (-not $credential -or [string]::IsNullOrWhiteSpace($credential.Secret)) {
        throw (Get-EawUiText -Text 'Сначала войдите в учётную запись.')
    }
    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = (Get-EawUiText -Text 'Изменение пароля EaW Hub')
    $dialog.Size = [System.Drawing.Size]::new(500, 325)
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $dialog.StartPosition = 'CenterParent'

    $notice = [System.Windows.Forms.Label]::new()
    $notice.Text = (Get-EawUiText -Text 'Используйте отдельный пароль только для этого сервера. После смены остальные активные сессии будут завершены.')
    $notice.ForeColor = [System.Drawing.Color]::DarkRed
    $notice.Location = [System.Drawing.Point]::new(20, 15)
    $notice.Size = [System.Drawing.Size]::new(445, 42)
    $dialog.Controls.Add($notice)

    $labels = @((Get-EawUiText -Text 'Текущий пароль:'), (Get-EawUiText -Text 'Новый пароль:'), (Get-EawUiText -Text 'Повтор нового пароля:'))
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
    $save.Text = (Get-EawUiText -Text 'Изменить')
    $save.Location = [System.Drawing.Point]::new(268, 215)
    $save.Size = [System.Drawing.Size]::new(95, 32)
    $dialog.Controls.Add($save)
    $cancel = [System.Windows.Forms.Button]::new()
    $cancel.Text = (Get-EawUiText -Text 'Отмена')
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.Location = [System.Drawing.Point]::new(370, 215)
    $cancel.Size = [System.Drawing.Size]::new(95, 32)
    $dialog.Controls.Add($cancel)
    $dialog.CancelButton = $cancel

    $save.Add_Click({
        try {
            if ($boxes[1].Text -cne $boxes[2].Text) { throw (Get-EawUiText -Text 'Новые пароли не совпадают.') }
            Assert-ValidNewPassword -Password $boxes[1].Text
            $body=@{currentPassword=$boxes[0].Text;newPassword=$boxes[1].Text}
            $save.Enabled=$false
            [void](Invoke-HubAuthApi -Key 'password-change' -Route '/api/auth/password/change' -Operation 'Изменение пароля' -Token $credential.Secret -Body $body -Success {
                $uiNetwork.Account=$null
                $status.Text=Get-EawUiText -Text 'Пароль изменён.'
                if($dialog.IsDisposed){return}
                $dialog.DialogResult=[Windows.Forms.DialogResult]::OK;$dialog.Close()
            }.GetNewClosure() -Failure {
                param($result,$payload)
                $status.Text=Get-HubApiErrorMessage $result $payload
                if(-not $dialog.IsDisposed){[void][Windows.Forms.MessageBox]::Show($dialog,$status.Text,(Get-EawUiText -Text 'Пароль не изменён'),'OK','Warning')}
            }.GetNewClosure() -Complete {if(-not $save.IsDisposed){$save.Enabled=$true}}.GetNewClosure())
            $boxes | ForEach-Object {$_.Clear()}
        } catch {
            $save.Enabled=$true
            [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,(Get-EawUiText -Text 'Пароль не изменён'),'OK','Warning')
        }
    })
    $changed=$dialog.ShowDialog($form) -eq [Windows.Forms.DialogResult]::OK
    $boxes | ForEach-Object {$_.Clear()};$dialog.Dispose()
    $changed
}

function Quote-AgentArgument {
    param([string]$Value)
    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw (Get-EawUiText -Text 'Параметр Agent содержит недопустимую кавычку или перенос строки.')
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
$languageButton = [Windows.Forms.Button]::new()
$languageButton.Text = 'RU / EN'
$languageButton.Location = [Drawing.Point]::new(585, 17)
$languageButton.Size = [Drawing.Size]::new(80, 27)
$languageButton.Add_Click({ Show-EawUiLanguageSettings -Owner $form })
$form.Controls.Add($languageButton)

$title = New-Label (Get-EawUiText -Text 'Настройка Desktop Agent') 24 18
$title.Font = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)

New-Label (Get-EawUiText -Text 'Сервер WebSocket:') 27 66 | Out-Null
$serverBox = New-TextBox 195 62 475
New-Label (Get-EawUiText -Text 'Репозиторий EaW:') 27 105 | Out-Null
$repoBox = New-TextBox 195 101 395
$browseButton = [System.Windows.Forms.Button]::new()
$browseButton.Text = (Get-EawUiText -Text 'Обзор…')
$browseButton.Location = [System.Drawing.Point]::new(597, 100)
$browseButton.Size = [System.Drawing.Size]::new(73, 26)
$form.Controls.Add($browseButton)
New-Label (Get-EawUiText -Text 'Имя участника:') 27 144 | Out-Null
$nameBox = New-TextBox 195 140 250
New-Label (Get-EawUiText -Text 'Цвет:') 465 144 | Out-Null
$colorBox = New-TextBox 515 140 100
$colorPickerButton = [System.Windows.Forms.Button]::new()
$colorPickerButton.AccessibleName = (Get-EawUiText -Text 'Выбрать цвет участника')
$colorPickerButton.Location = [System.Drawing.Point]::new(622, 139)
$colorPickerButton.Size = [System.Drawing.Size]::new(48, 27)
$colorPickerButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$colorPickerButton.UseVisualStyleBackColor = $false
$form.Controls.Add($colorPickerButton)
$warning = [System.Windows.Forms.Label]::new()
$warning.Text = (Get-EawUiText -Text 'ВАЖНО: придумайте отдельный пароль только для этого сервера. Не используйте пароль от GitHub, Discord, почты, банка или любого другого сайта.')
$warning.ForeColor = [System.Drawing.Color]::DarkRed
$warning.Font = [System.Drawing.Font]::new('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$warning.Location = [System.Drawing.Point]::new(27, 177)
$warning.Size = [System.Drawing.Size]::new(643, 46)
$form.Controls.Add($warning)

New-Label (Get-EawUiText -Text 'Приглашение / код восстановления:') 27 239 | Out-Null
$inviteBox = New-TextBox 245 235 425
New-Label (Get-EawUiText -Text 'Пароль:') 27 278 | Out-Null
$passwordBox = New-TextBox 220 274 450
$passwordBox.UseSystemPasswordChar = $true
New-Label (Get-EawUiText -Text 'Повтор нового пароля:') 27 317 | Out-Null
$passwordConfirmBox = New-TextBox 220 313 450
$passwordConfirmBox.UseSystemPasswordChar = $true

$activateButton = [System.Windows.Forms.Button]::new()
$activateButton.Text = (Get-EawUiText -Text 'Регистрация по приглашению')
$activateButton.Location = [System.Drawing.Point]::new(27, 353)
$activateButton.Size = [System.Drawing.Size]::new(210, 34)
$form.Controls.Add($activateButton)
$loginButton = [System.Windows.Forms.Button]::new()
$loginButton.Text = (Get-EawUiText -Text 'Войти по паролю')
$loginButton.Location = [System.Drawing.Point]::new(247, 353)
$loginButton.Size = [System.Drawing.Size]::new(190, 34)
$form.Controls.Add($loginButton)
$resetPasswordButton = [System.Windows.Forms.Button]::new()
$resetPasswordButton.Text = (Get-EawUiText -Text 'Восстановить по коду')
$resetPasswordButton.Location = [System.Drawing.Point]::new(447, 353)
$resetPasswordButton.Size = [System.Drawing.Size]::new(180, 34)
$form.Controls.Add($resetPasswordButton)

$startupCheck = [System.Windows.Forms.CheckBox]::new()
$startupCheck.Text = (Get-EawUiText -Text 'Запускать Agent вместе с Windows')
$startupCheck.AutoSize = $true
$startupCheck.Location = [System.Drawing.Point]::new(27, 407)
$form.Controls.Add($startupCheck)

$trayModeCheck = [System.Windows.Forms.CheckBox]::new()
$trayModeCheck.Text = (Get-EawUiText -Text 'После закрытия оставлять в области уведомлений')
$trayModeCheck.AutoSize = $true
$trayModeCheck.Location = [System.Drawing.Point]::new(300, 407)
$form.Controls.Add($trayModeCheck)

$startButton = [System.Windows.Forms.Button]::new()
$startButton.Text = (Get-EawUiText -Text 'Запустить Agent')
$startButton.Location = [System.Drawing.Point]::new(27, 441)
$startButton.Size = [System.Drawing.Size]::new(190, 38)
$form.Controls.Add($startButton)
$stopButton = [System.Windows.Forms.Button]::new()
$stopButton.Text = (Get-EawUiText -Text 'Остановить Agent')
$stopButton.Location = [System.Drawing.Point]::new(228, 441)
$stopButton.Size = [System.Drawing.Size]::new(190, 38)
$form.Controls.Add($stopButton)
$logoutButton = [System.Windows.Forms.Button]::new()
$logoutButton.Text = (Get-EawUiText -Text 'Выйти и удалить токен')
$logoutButton.Location = [System.Drawing.Point]::new(429, 441)
$logoutButton.Size = [System.Drawing.Size]::new(210, 38)
$form.Controls.Add($logoutButton)
$reviewButton = [System.Windows.Forms.Button]::new()
$reviewButton.Text = (Get-EawUiText -Text 'Запустить Review')
$reviewButton.Location = [System.Drawing.Point]::new(27, 487)
$reviewButton.Size = [System.Drawing.Size]::new(391, 32)
$reviewButton.Enabled = $false
$form.Controls.Add($reviewButton)
$changePasswordButton = [System.Windows.Forms.Button]::new()
$changePasswordButton.Text = (Get-EawUiText -Text 'Изменить мой пароль…')
$changePasswordButton.Location = [System.Drawing.Point]::new(429, 487)
$changePasswordButton.Size = [System.Drawing.Size]::new(210, 32)
$form.Controls.Add($changePasswordButton)

$stateGroup = [System.Windows.Forms.GroupBox]::new()
$stateGroup.Text = (Get-EawUiText -Text 'Состояние')
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
$lastCheckState.Location = [System.Drawing.Point]::new(14, 79)
$lastCheckState.Size = [System.Drawing.Size]::new(288, 43)
$stateGroup.Controls.Add($lastCheckState)
$checkStateButton = [System.Windows.Forms.Button]::new()
$checkStateButton.Text = (Get-EawUiText -Text 'Проверить сейчас')
$checkStateButton.Location = [System.Drawing.Point]::new(470, 80)
$checkStateButton.Size = [System.Drawing.Size]::new(155, 30)
$stateGroup.Controls.Add($checkStateButton)
$updateClientButton = [System.Windows.Forms.Button]::new()
$updateClientButton.Text = (Get-EawUiText -Text 'Обновить клиент…')
$updateClientButton.Location = [System.Drawing.Point]::new(308, 80)
$updateClientButton.Size = [System.Drawing.Size]::new(155, 30)
$stateGroup.Controls.Add($updateClientButton)

$status = [System.Windows.Forms.Label]::new()
$status.Text = (Get-EawUiText -Text 'Для первого входа нужны приглашение и новый пароль; затем достаточно имени и пароля.')
$status.BorderStyle = 'FixedSingle'
$status.Location = [System.Drawing.Point]::new(27, 830)
$status.Size = [System.Drawing.Size]::new(643, 66)
$status.TextAlign = 'MiddleLeft'
$form.Controls.Add($status)

$repositoryGroup = [System.Windows.Forms.GroupBox]::new()
$repositoryGroup.Text = (Get-EawUiText -Text 'Git – текущая ветка репозитория (не обновление клиента)')
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
    @('details', (Get-EawUiText -Text 'Подробнее'), 14, 95),
    @('check', (Get-EawUiText -Text 'Проверить снова'), 116, 135),
    @('update', (Get-EawUiText -Text 'Обновить репозиторий сейчас'), 258, 215),
    @('settings', (Get-EawUiText -Text 'Настройки Git…'), 480, 145)
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
$showTrayItem = $trayMenu.Items.Add((Get-EawUiText -Text 'Открыть настройки'))
$startTrayItem = $trayMenu.Items.Add((Get-EawUiText -Text 'Запустить Agent'))
$stopTrayItem = $trayMenu.Items.Add((Get-EawUiText -Text 'Остановить Agent'))
$trayMenu.Items.Add('-') | Out-Null
$exitTrayItem = $trayMenu.Items.Add((Get-EawUiText -Text 'Закрыть Agent'))
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
    $stateText = (Get-EawUiText -Text 'Git: выберите корректный репозиторий EaW.')
    $stateColor = [Drawing.Color]::DimGray
    try {
        $directory = Get-EawRepositorySyncDirectory $stateDirectory $repoBox.Text.Trim()
        $settings = Get-EawRepositorySyncSettings $directory
        $automationText = (Get-EawUiText -Text 'Авто-fetch: ') + $(if ($settings.autoFetch -or $settings.autoPull) { (Get-EawUiText -Text 'вкл.') } else { (Get-EawUiText -Text 'выкл.') }) +
            (Get-EawUiText -Text '; автообновление ветки: ') + $(if ($settings.autoPull) { (Get-EawUiText -Text 'вкл.') } else { (Get-EawUiText -Text 'выкл.') })
        $stateText = $automationText + (Get-EawUiText -Text '
Запустите Agent для работы с Git.')
        $agent = Sync-AgentProcessReference
        if (-not $agent -or $agent.HasExited) { return }
        $value = Read-EawRepositorySyncJson (Join-Path $directory 'status.json')
        if (-not (Test-EawRepositorySyncStatus $value $agent.Id $repoBox.Text.Trim())) { return }
        $script:repositorySyncStatus = $value
        $busy = $value.stage -in @('checking', 'fetching', 'updating')
        $buttonsEnabled = -not $busy
        $counts = $(if ($null -ne $value.behind) { (Get-EawUiText -Text ' | новых коммитов: {0}' -Values @($($value.behind))) } else { '' })
        $stateText = "$automationText`r`n$($value.branch)$counts`r`n$(Get-EawUiMessage $value.message)"
        if ($value.stage -eq 'blocked' -and [int]$value.behind -gt 0) { $stateColor = [Drawing.Color]::Firebrick }
        elseif ($value.stage -in @('current', 'updated')) { $stateColor = [Drawing.Color]::ForestGreen }
        elseif ($value.stage -eq 'error') { $stateColor = [Drawing.Color]::DarkOrange }
        if ($value.alertId -and -not $script:seenRepositoryAlerts.ContainsKey([string]$value.alertId)) {
            $script:seenRepositoryAlerts[[string]$value.alertId] = $true
            Show-EawRepositorySyncAlert $form $tray $settings (Get-EawUiText -Text 'Ветка {0}: новых коммитов – {1}. {2}' -Values @($($value.branch), $($value.behind), $(Get-EawUiMessage $value.message)))
        }
    } catch {
        $script:repositorySyncStatus = $null
        $buttonsEnabled = $false
        $stateText = (Get-EawUiText -Text 'Git: выберите корректный репозиторий EaW.')
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
    } catch { $status.Text = (Get-EawUiText -Text 'Ошибка настроек Git: {0}' -Values @($($_.Exception.Message))) }
})
$repositoryButtons['details'].Add_Click({
    $value = $script:repositorySyncStatus
    $message = if ($value) {
        (Get-EawUiText -Text 'Репозиторий: {0}
Ветка: {1}
Upstream: {2}
Новых коммитов: {3}; локальных: {4}
{5}

{6}' -Values @($($value.repository), $($value.branch), $($value.upstream), $($value.behind), $($value.ahead), $(Get-EawRepositorySyncTiming $value), $(Get-EawUiMessage $value.message)))
    } else { $repositoryState.Text }
    [void][Windows.Forms.MessageBox]::Show($form, $message, (Get-EawUiText -Text 'Состояние Git'), 'OK', 'Information')
})
function Send-RepositorySyncRequest {
    param([ValidateSet('check', 'update')][string]$Action)
    Update-RepositorySyncView
    if (-not $script:repositorySyncStatus) { throw (Get-EawUiText -Text 'Запустите Agent с выбранным репозиторием.') }
    $directory = Get-EawRepositorySyncDirectory $stateDirectory $repoBox.Text.Trim()
    Request-EawRepositorySync $directory $script:agentProcess.Id $Action
    $repositoryButtons['check'].Enabled = $false; $repositoryButtons['update'].Enabled = $false
    $repositoryState.Text = (Get-EawUiText -Text 'Запрос отправлен Agent…')
}
$repositoryButtons['check'].Add_Click({
    try { Send-RepositorySyncRequest 'check' } catch { $status.Text = $_.Exception.Message }
})
$repositoryButtons['update'].Add_Click({
    $answer = [Windows.Forms.MessageBox]::Show($form,
        (Get-EawUiText -Text 'Проверить remote и обновить текущую ветку до upstream? Только fast-forward и только при чистом рабочем каталоге. Локальные изменения не удаляются и не прячутся в stash.'),
        (Get-EawUiText -Text 'Обновить Git-репозиторий'), 'YesNo', 'Question', 'Button2')
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

function Complete-AgentStateCheck {
    $uiNetwork.Checking=$false;$checkStateButton.Enabled=$true
    $confirmed=if($uiNetwork.ConfirmedAt){$uiNetwork.ConfirmedAt.ToString('G')}else{'–'}
    $lastCheckState.Text=(Get-EawUiText -Text 'Проверка: {0}' -Values @([DateTime]::Now.ToString('G')))+"`r`n"+(Get-EawUiText -Text 'Токен подтверждён: {0}' -Values @($confirmed))
}

function Update-AgentStateView {
    param([switch]$LocalOnly)
    [void](Sync-AgentProcessReference)
    if($script:agentProcess -and -not $script:agentProcess.HasExited){
        Set-StateText $agentState (Get-EawUiText -Text 'Agent: запущен (PID {0})' -Values @($script:agentProcess.Id)) ([Drawing.Color]::ForestGreen)
        $reviewButton.Enabled=$true
    }else{
        Set-StateText $agentState (Get-EawUiText -Text 'Agent: остановлен') ([Drawing.Color]::DimGray);$reviewButton.Enabled=$false
    }
    if($LocalOnly -or $uiNetwork.Checking){return}
    $uiNetwork.Checking=$true;$checkStateButton.Enabled=$false
    Set-StateText $serverState (Get-EawUiText -Text 'Сервер: проверка…') ([Drawing.Color]::DimGray)
    Set-StateText $tokenState (Get-EawUiText -Text 'Токен: проверка…') ([Drawing.Color]::DimGray)
    $phase=@{AccountStarted=$false}
    try {
        [void](Invoke-HubAuthApi -Key 'health-state' -Route '/health' -Method GET -Success {
            param($health)
            Set-StateText $serverState (Get-EawUiText -Text 'Сервер: доступен ({0})' -Values @($health.version)) ([Drawing.Color]::ForestGreen)
            $comparison=Compare-EawHubDisplayVersion -Installed $clientStatusMetadata.Version -Recommended ([string]$health.version)
            if([int]$health.protocol -ne $clientStatusMetadata.Protocol){
                Set-StateText $versionState (Get-EawUiText -Text 'Протокол несовместим: клиент {0}, сервер {1}' -Values @($clientStatusMetadata.Protocol,$health.protocol)) ([Drawing.Color]::Firebrick)
                Start-ClientUpdateCheck
            }elseif($null -eq $comparison){
                Set-StateText $versionState (Get-EawUiText -Text 'Версии: клиент {0}, сервер {1}' -Values @($clientStatusMetadata.Version,$health.version)) ([Drawing.Color]::DarkOrange)
            }elseif($comparison -lt 0){
                Set-StateText $versionState (Get-EawUiText -Text 'Доступно обновление: {0} → {1}' -Values @($clientStatusMetadata.Version,$health.version)) ([Drawing.Color]::DarkOrange);Start-ClientUpdateCheck
            }elseif($comparison -gt 0){
                Set-StateText $versionState (Get-EawUiText -Text 'Клиент {0}; сервер требует обновления ({1})' -Values @($clientStatusMetadata.Version,$health.version)) ([Drawing.Color]::SteelBlue)
            }else{
                Set-StateText $versionState (Get-EawUiText -Text 'Версия актуальна: {0}, EHSP {1}' -Values @($clientStatusMetadata.Version,$health.protocol)) ([Drawing.Color]::ForestGreen)
            }
            $target=Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken';$credential=Get-EawHubCredential -Target $target
            if(-not $credential -or [string]::IsNullOrWhiteSpace($credential.Secret)){
                Set-StateText $tokenState (Get-EawUiText -Text 'Токен: отсутствует') ([Drawing.Color]::DarkOrange);return
            }
            $phase.AccountStarted=Invoke-HubAuthApi -Key 'account-state' -Route '/api/auth/me' -Method GET -Token $credential.Secret -Success {
                param($account)
                $uiNetwork.Account=$account.user;$uiNetwork.AccountServer=$serverBox.Text.Trim()
                $uiNetwork.ConfirmedAt=[DateTime]::Now
                if($account.user.temporaryPassword){Set-StateText $tokenState (Get-EawUiText -Text 'Токен: действует; смените временный пароль') ([Drawing.Color]::DarkOrange)}
                else{Set-StateText $tokenState (Get-EawUiText -Text 'Токен: действует ({0})' -Values @($account.user.displayName)) ([Drawing.Color]::ForestGreen)}
            } -Failure {
                param($result,$payload)
                if(-not $result.NetworkError -and $result.Status -in @(401,403)){
                    Set-StateText $tokenState (Get-EawUiText -Text 'Токен: истёк или отозван – войдите снова') ([Drawing.Color]::Firebrick)
                }else{Set-StateText $tokenState (Get-EawUiText -Text 'Токен: состояние неизвестно') ([Drawing.Color]::DarkOrange)}
            } -Complete {Complete-AgentStateCheck}
        }.GetNewClosure() -Failure {
            Set-StateText $serverState (Get-EawUiText -Text 'Сервер: недоступен') ([Drawing.Color]::Firebrick)
            Set-StateText $versionState (Get-EawUiText -Text 'Клиент: {0}; обновление не проверено' -Values @($clientStatusMetadata.Version)) ([Drawing.Color]::DarkOrange)
            Set-StateText $tokenState (Get-EawUiText -Text 'Токен: состояние неизвестно') ([Drawing.Color]::DarkOrange)
        } -Complete {if(-not $phase.AccountStarted){Complete-AgentStateCheck}}.GetNewClosure())
    }catch{Complete-AgentStateCheck;$status.Text=$_.Exception.Message}
}

function Stop-AgentProcess {
    Cancel-AgentStart
    if ($agentStartCheckTimer) { $agentStartCheckTimer.Stop() }
    $script:startedAgentProcess=$null
    [void](Sync-AgentProcessReference)
    if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
        Stop-Process -Id $script:agentProcess.Id -ErrorAction Stop
        # Termination is immediate; the short bounded wait only keeps the state view accurate.
        [void]$script:agentProcess.WaitForExit(500)
    }
    $script:agentProcess = $null
    $status.Text = (Get-EawUiText -Text 'Desktop Agent остановлен.')
    Update-AgentStateView -LocalOnly
}

function Start-AgentProcess {
    param([switch]$AccountChecked)
    [void](Sync-AgentProcessReference)
    if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
        $status.Text = (Get-EawUiText -Text 'Desktop Agent уже запущен (PID {0}).' -Values @($($script:agentProcess.Id)))
        return
    }
    $config = Current-Config
    if (-not (Test-Path -LiteralPath $config.Repo -PathType Container)) { throw (Get-EawUiText -Text 'Выбранный репозиторий не найден.') }
    if ($config.Server -notmatch '^wss?://') { throw (Get-EawUiText -Text 'Адрес сервера должен начинаться с ws:// или wss://.') }
    Assert-SecureTransport -Server $config.Server
    if ($config.Color -notmatch '^#[0-9A-Fa-f]{6}$') { throw (Get-EawUiText -Text 'Цвет должен иметь вид #RRGGBB.') }
    $credentialTarget = Get-EawHubCredentialTarget -Server $config.Server -Kind 'AgentToken'
    $credential = Get-EawHubCredential -Target $credentialTarget
    if (-not $credential -or [string]::IsNullOrWhiteSpace($credential.Secret)) {
        throw (Get-EawUiText -Text 'Сначала зарегистрируйтесь или войдите.')
    }
    if (-not $AccountChecked -and ($uiNetwork.AccountServer -cne $config.Server -or -not $uiNetwork.Account)) {
        # No confirmed account state for this server yet: check it without blocking the
        # window, then start. A network failure still starts Agent; the server enforces it.
        $status.Text = Get-EawUiText -Text 'Проверка аккаунта перед запуском…'
        if ($uiNetwork.StartIntent) { return }
        $intent=[Guid]::NewGuid().ToString('N')
        $uiNetwork.StartIntent=$intent
        $server = $config.Server
        try {
            $queued=Invoke-HubAuthApi -Key 'start-check' -Route '/api/auth/me' -Method GET -Token $credential.Secret -Success {
                param($account)
                if ($uiNetwork.StartIntent -cne $intent) { return }
                $uiNetwork.StartIntent=$null
                $uiNetwork.Account = $account.user; $uiNetwork.AccountServer = $server
                try { Start-AgentProcess -AccountChecked } catch { $status.Text = Get-EawUiText -Text 'Ошибка запуска: {0}' -Values @($_.Exception.Message) }
            }.GetNewClosure() -Failure {
                param($result, $payload)
                if ($uiNetwork.StartIntent -cne $intent) { return }
                $uiNetwork.StartIntent=$null
                if (-not $result.NetworkError -and $result.Status -in @(401, 403)) {
                    $status.Text = Get-EawUiText -Text 'Токен: истёк или отозван – войдите снова'; return
                }
                try { Start-AgentProcess -AccountChecked } catch { $status.Text = Get-EawUiText -Text 'Ошибка запуска: {0}' -Values @($_.Exception.Message) }
            }.GetNewClosure() -Complete {
                if ($uiNetwork.StartIntent -ceq $intent) { $uiNetwork.StartIntent=$null }
            }.GetNewClosure()
            if (-not $queued) { $uiNetwork.StartIntent=$null }
        } catch {
            if ($uiNetwork.StartIntent -ceq $intent) { $uiNetwork.StartIntent=$null }
            throw
        }
        return
    }
    if ($uiNetwork.AccountServer -ceq $config.Server -and $uiNetwork.Account.temporaryPassword) {
        throw (Get-EawUiText -Text 'Сначала замените временный пароль на собственный постоянный пароль.')
    }
    Cancel-AgentStart
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
        # A start failure (a second instance, bad configuration) exits within moments;
        # check it shortly afterwards instead of sleeping in the window thread.
        [void]$script:agentProcess.Handle
        $script:startedAgentProcess = $script:agentProcess
        $agentStartCheckTimer.Stop(); $agentStartCheckTimer.Start()
    }
    finally {
        if ($null -eq $previousToken) { Remove-Item Env:EAW_HUB_TOKEN -ErrorAction SilentlyContinue }
        else { $env:EAW_HUB_TOKEN = $previousToken }
    }
    $status.Text = (Get-EawUiText -Text 'Desktop Agent запущен (PID {0}). Токен получен из Windows Credential Manager.' -Values @($($script:agentProcess.Id)))
    Update-AgentStateView
}

function Confirm-AgentStarted {
    $process = $script:startedAgentProcess; $script:startedAgentProcess = $null
    if (-not $process -or -not $process.HasExited) { return }
    $exitCode = $process.ExitCode
    $script:agentProcess = Find-RegisteredAgentProcess
    if ($script:agentProcess -and -not $script:agentProcess.HasExited) {
        $status.Text = Get-EawUiText -Text 'Обнаружен уже работающий Desktop Agent (PID {0}).' -Values @($script:agentProcess.Id)
    } else {
        $status.Text = Get-EawUiText -Text 'Desktop Agent завершился при запуске с кодом {0}. Проверьте журнал: {1}' -Values @($exitCode, $logDirectory)
    }
    Update-AgentStateView -LocalOnly
}
$agentStartCheckTimer = [System.Windows.Forms.Timer]::new()
$agentStartCheckTimer.Interval = 700
$agentStartCheckTimer.Add_Tick({ $agentStartCheckTimer.Stop(); Confirm-AgentStarted })

# start-hub.ps1 can wait for Agent for up to 25 seconds, so it runs as a separate
# process; its exit code and error output are read back here.
$script:reviewLaunch = $null
function Confirm-ReviewLaunch {
    $launch = $script:reviewLaunch
    if (-not $launch -or -not $launch.Process.HasExited) { return }
    $script:reviewLaunch = $null; $reviewLaunchTimer.Stop()
    if ($launch.Process.ExitCode -eq 0) { $status.Text = Get-EawUiText -Text 'Review запущен.'; return }
    $detail = ''
    try {
        $detail = (Get-Content -LiteralPath $launch.ErrorLog -Encoding utf8 -ErrorAction Stop |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1) -replace '^.*?\.ps1\s*:\s*', ''
    } catch {}
    if (-not $detail) { $detail = Get-EawUiText -Text 'код завершения {0}' -Values @($launch.Process.ExitCode) }
    $status.Text = Get-EawUiText -Text 'Ошибка запуска Review: {0}' -Values @((Get-EawUiMessage ([string]$detail).Trim()))
}
$reviewLaunchTimer = [System.Windows.Forms.Timer]::new()
$reviewLaunchTimer.Interval = 250
$reviewLaunchTimer.Add_Tick({ try { Confirm-ReviewLaunch } catch { $reviewLaunchTimer.Stop(); $script:reviewLaunch = $null } })

$colorTip = [System.Windows.Forms.ToolTip]::new()
$colorTip.SetToolTip($colorPickerButton, (Get-EawUiText -Text 'Выбрать цвет участника'))
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
    $dialog.Description = (Get-EawUiText -Text 'Выберите корень локального репозитория EaW')
    if ($repoBox.Text -and (Test-Path -LiteralPath $repoBox.Text)) { $dialog.SelectedPath = $repoBox.Text }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $repoBox.Text = $dialog.SelectedPath }
})

$activateButton.Add_Click({
    try {
        if($passwordBox.Text -cne $passwordConfirmBox.Text){throw (Get-EawUiText -Text 'Пароли не совпадают.')}
        Assert-ValidNewPassword -Password $passwordBox.Text;Set-AccountActionBusy $true
        $status.Text=Get-EawUiText -Text 'Проверка приглашения…'
        [void](Invoke-HubAuthApi -Route '/api/auth/redeem' -Body @{inviteCode=$inviteBox.Text.Trim();displayName=$nameBox.Text.Trim();password=$passwordBox.Text} -Success {
            param($result)
            Save-AuthenticatedSession $result
            if(-not (Save-RecoveryCodeFile -Code $result.recoveryCode -DisplayName $result.user.displayName -Token $result.token)){
                $status.Text=Get-EawUiText -Text 'Аккаунт создан, но код восстановления не сохранён. В Review будет постоянно показано предупреждение.'
            };$inviteBox.Clear()
        } -Complete {Set-AccountActionBusy $false})
    }catch{Set-AccountActionBusy $false;$status.Text=$_.Exception.Message}
    finally{$passwordBox.Clear();$passwordConfirmBox.Clear()}
})

$loginButton.Add_Click({
    try{
        Set-AccountActionBusy $true;$status.Text=Get-EawUiText -Text 'Проверка имени и пароля…'
        [void](Invoke-HubAuthApi -Route '/api/auth/login' -Body @{displayName=$nameBox.Text.Trim();password=$passwordBox.Text} -Success {
            param($result)
            Save-AuthenticatedSession $result
            if($result.user.temporaryPassword){[void](Show-ChangePasswordDialog)}
        } -Complete {Set-AccountActionBusy $false})
    }catch{Set-AccountActionBusy $false;$status.Text=$_.Exception.Message}
    finally{$passwordBox.Clear();$passwordConfirmBox.Clear()}
})

$resetPasswordButton.Add_Click({
    try{
        if($passwordBox.Text -cne $passwordConfirmBox.Text){throw (Get-EawUiText -Text 'Пароли не совпадают.')}
        Assert-ValidNewPassword -Password $passwordBox.Text;Set-AccountActionBusy $true
        $status.Text=Get-EawUiText -Text 'Проверка одноразового кода восстановления…'
        [void](Invoke-HubAuthApi -Route '/api/auth/password/recover' -Body @{displayName=$nameBox.Text.Trim();recoveryCode=$inviteBox.Text.Trim();newPassword=$passwordBox.Text} -Success {
            param($result) Save-AuthenticatedSession $result;$inviteBox.Clear()
        } -Complete {Set-AccountActionBusy $false})
    }catch{Set-AccountActionBusy $false;$status.Text=$_.Exception.Message}
    finally{$passwordBox.Clear();$passwordConfirmBox.Clear()}
})

$startButton.Add_Click({ try { Start-AgentProcess } catch { $status.Text = (Get-EawUiText -Text 'Ошибка запуска: {0}' -Values @($($_.Exception.Message))) } })
$stopButton.Add_Click({ try { Stop-AgentProcess } catch { $status.Text = (Get-EawUiText -Text 'Ошибка остановки: {0}' -Values @($($_.Exception.Message))) } })
$reviewButton.Add_Click({
    try {
        $reviewButton.Enabled = $false
        $status.Text = (Get-EawUiText -Text 'Открытие Review…')
        $form.Refresh()
        $arguments='-NoProfile -ExecutionPolicy Bypass -File '+(Quote-AgentArgument (Join-Path $PSScriptRoot 'start-hub.ps1'))
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $errorLog = Join-Path $logDirectory 'review-launch.err.log'
        $process = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList $arguments -WorkingDirectory $projectRoot `
            -WindowStyle Hidden -RedirectStandardError $errorLog -PassThru
        # Windows PowerShell reports no ExitCode unless the handle is opened before exit.
        [void]$process.Handle
        $script:reviewLaunch = @{ Process = $process; ErrorLog = $errorLog }
        $reviewLaunchTimer.Start()
    } catch {
        $status.Text = (Get-EawUiText -Text 'Ошибка запуска Review: {0}' -Values @($($_.Exception.Message)))
    } finally {
        [void](Sync-AgentProcessReference)
        $reviewButton.Enabled = $script:agentProcess -and -not $script:agentProcess.HasExited
    }
})
$logoutButton.Add_Click({
    $credentialTarget=Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken'
    $credential=Get-EawHubCredential -Target $credentialTarget
    Stop-AgentProcess
    Remove-EawHubCredential -Target $credentialTarget;$uiNetwork.Account=$null;$uiNetwork.ConfirmedAt=$null
    $status.Text=Get-EawUiText -Text 'Выход выполнен, токен удалён из Windows Credential Manager.'
    if($credential -and $credential.Secret){
        [void](Invoke-HubAuthApi -Key 'logout' -Route '/api/auth/logout' -Operation 'Выход из аккаунта' -Token $credential.Secret -Body @{} -Failure {
            $status.Text=(Get-EawUiText -Text 'Выход выполнен, токен удалён из Windows Credential Manager.')+(Get-EawUiText -Text ' Сервер недоступен, поэтому удалён только локальный токен.')
        })
    }
    Update-AgentStateView -LocalOnly
})

$changePasswordButton.Add_Click({
    try {
        if (Show-ChangePasswordDialog) {
            $status.Text = (Get-EawUiText -Text 'Пароль изменён. Текущая сессия сохранена, остальные завершены.')
        }
    } catch { $status.Text = (Get-EawUiText -Text 'Не удалось изменить пароль: {0}' -Values @($($_.Exception.Message))) }
})
$startupCheck.Add_CheckedChanged({
    try { Set-StartupShortcut -Enabled $startupCheck.Checked } catch { $status.Text = (Get-EawUiText -Text 'Не удалось изменить автозапуск: {0}' -Values @($($_.Exception.Message))) }
})
$trayModeCheck.Add_CheckedChanged({ Save-AgentConfig (Current-Config) })
$checkStateButton.Add_Click({
    Update-AgentStateView
    try { Start-ClientUpdateCheck } catch { $status.Text = (Get-EawUiText -Text 'Ошибка проверки обновления: {0}' -Values @($($_.Exception.Message))) }
})
$updateClientButton.Add_Click({
    $answer = [System.Windows.Forms.MessageBox]::Show($form,
        (Get-EawUiText -Text 'Скачать и установить новую версию с GitHub Releases? Если обновление найдено, Agent и Review будут закрыты на время установки, затем запущены снова. Windows может запросить права администратора. Без вашего подтверждения клиент не обновляется.'),
        (Get-EawUiText -Text 'Обновление EaW Localisation Hub'), 'YesNo', 'Question', 'Button2')
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    try { Start-ClientUpdateCheck -Install } catch { $status.Text = (Get-EawUiText -Text 'Не удалось запустить обновление: {0}' -Values @($($_.Exception.Message))) }
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
        $tray.ShowBalloonTip(2500, 'EaW Hub', (Get-EawUiText -Text 'Desktop Agent продолжает работать в области уведомлений.'), 'Info')
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
                        $tray.ShowBalloonTip(5000, (Get-EawUiText -Text 'EaW Hub – ошибка обновления'), [string]$updateStatus.Message, 'Error')
                    }
                }
            }
        } catch {}
    }
    if ($script:agentProcess -and $script:agentProcess.HasExited) {
        $exitCode = $script:agentProcess.ExitCode
        $script:agentProcess = $null
        $status.Text = (Get-EawUiText -Text 'Desktop Agent завершился с кодом {0}. Проверьте журнал: {1}' -Values @($exitCode, $logDirectory))
    }
})
$timer.Start()

$networkTimer=[Windows.Forms.Timer]::new()
$networkTimer.Interval=100
$networkTimer.Add_Tick({
    try{Receive-EawAgentRequests -CurrentServer $serverBox.Text.Trim()}
    catch{$status.Text=$_.Exception.Message}
})
$networkTimer.Start()
# Only state checks are cancelled: logout or a password change already sent must finish
# and report for their original server, without changing the selected account.
$serverBox.Add_TextChanged({Cancel-AgentStart;Stop-EawAgentRequests -Keys @('health-state','account-state');$uiNetwork.Account=$null;$uiNetwork.ConfirmedAt=$null;$lastCheckState.Text=''})
$serverBox.Add_Leave({Update-AgentStateView})
$form.Add_FormClosed({Stop-EawAgentRequests;$networkTimer.Stop()})

$stateTimer = [System.Windows.Forms.Timer]::new()
$stateTimer.Interval = 15000
$stateTimer.Add_Tick({ Update-AgentStateView })
$stateTimer.Start()
Update-AgentStateView

$updateTimer = [System.Windows.Forms.Timer]::new()
$updateTimer.Interval = 15 * 60 * 1000
$updateTimer.Add_Tick({ try { Start-ClientUpdateCheck } catch { $status.Text = (Get-EawUiText -Text 'Ошибка проверки обновления: {0}' -Values @($($_.Exception.Message))) } })
$updateTimer.Start()
$form.Add_Shown({ try { Start-ClientUpdateCheck } catch { $status.Text = (Get-EawUiText -Text 'Ошибка проверки обновления: {0}' -Values @($($_.Exception.Message))) } })

if ($StartMinimized) {
    $form.Add_Shown({
        $form.Hide()
        try { Start-AgentProcess } catch { $tray.ShowBalloonTip(5000, (Get-EawUiText -Text 'EaW Hub – ошибка запуска'), $_.Exception.Message, 'Error') }
    })
}
[void]$form.ShowDialog()
$timer.Stop()
$agentStartCheckTimer.Stop(); $reviewLaunchTimer.Stop()
$stateTimer.Stop()
$updateTimer.Stop()
$networkTimer.Stop();Stop-EawAgentRequests
$tray.Dispose()
