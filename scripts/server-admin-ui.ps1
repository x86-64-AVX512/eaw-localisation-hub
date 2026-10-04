param([switch]$TeamManagement)
. (Join-Path $PSScriptRoot 'ui-language.ps1')


$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'credential-store.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $env:LOCALAPPDATA 'EaWLocalisationHub'
$configPath = Join-Path $stateDirectory 'agent-config.json'
$passphraseTarget = 'EaWLocalisationHub.BackupPassphrase'
$script:userRows = @()
$script:adminToken = ''
$script:adminServer = ''
$script:adminIssuedAt = [DateTime]::MinValue
$script:managerUser = $null

function Read-AgentServer {
    if (-not (Test-Path -LiteralPath $configPath)) { return 'wss://eawhub.mooo.com:10443' }
    try {
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($config.Server) { return [string]$config.Server }
    } catch {}
    'wss://eawhub.mooo.com:10443'
}

function Convert-HubServerToHttp([string]$Server) {
    $uri = [Uri]$Server
    $loopback = $uri.Host -in @('localhost', '127.0.0.1', '::1')
    if ($uri.Scheme -in @('ws', 'http') -and -not $loopback) {
        throw (Get-EawUiText -Text 'Передача токена по незашифрованному соединению запрещена. Для удалённого сервера используйте wss:// или https://.')
    }
    $builder = [UriBuilder]::new($uri)
    if ($builder.Scheme -eq 'ws') { $builder.Scheme = 'http' }
    elseif ($builder.Scheme -eq 'wss') { $builder.Scheme = 'https' }
    elseif ($builder.Scheme -notin @('http', 'https')) { throw (Get-EawUiText -Text 'Адрес должен начинаться с ws://, wss://, http:// или https://.') }
    $builder.Path = ''
    $builder.Query = ''
    $builder.Uri.AbsoluteUri.TrimEnd('/')
}

function Invoke-HubApiWithToken {
    param([string]$Method, [string]$Route, [string]$Token, $Body = $null)
    $parameters = @{
        Method = $Method
        Uri = (Convert-HubServerToHttp $serverBox.Text.Trim()) + $Route
        Headers = @{ Authorization = 'Bearer ' + $Token }
    }
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json; charset=utf-8'
        $parameters.Body = $Body | ConvertTo-Json -Compress
    }
    Invoke-RestMethod @parameters
}

function Read-AdminPassword([string]$DisplayName) {
    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = (Get-EawUiText -Text 'Подтверждение управления командой')
    $dialog.Size = [System.Drawing.Size]::new(455, 205)
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $dialog.StartPosition = 'CenterParent'
    $label = [System.Windows.Forms.Label]::new()
    $label.Text = (Get-EawUiText -Text 'Повторно введите пароль учётной записи «{0}».' -Values @($DisplayName))
    $label.Location = [System.Drawing.Point]::new(20, 18)
    $label.Size = [System.Drawing.Size]::new(400, 32)
    $dialog.Controls.Add($label)
    $password = [System.Windows.Forms.TextBox]::new()
    $password.UseSystemPasswordChar = $true
    $password.Location = [System.Drawing.Point]::new(20, 58)
    $password.Size = [System.Drawing.Size]::new(400, 24)
    $dialog.Controls.Add($password)
    $ok = [System.Windows.Forms.Button]::new()
    $ok.Text = (Get-EawUiText -Text 'Войти')
    $ok.Location = [System.Drawing.Point]::new(220, 105)
    $ok.Size = [System.Drawing.Size]::new(95, 31)
    $dialog.Controls.Add($ok)
    $cancel = [System.Windows.Forms.Button]::new()
    $cancel.Text = (Get-EawUiText -Text 'Отмена')
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.Location = [System.Drawing.Point]::new(325, 105)
    $cancel.Size = [System.Drawing.Size]::new(95, 31)
    $dialog.Controls.Add($cancel)
    $dialog.CancelButton = $cancel
    $dialog.AcceptButton = $ok
    $ok.Add_Click({
        if ([string]::IsNullOrEmpty($password.Text)) { return }
        $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $dialog.Close()
    })
    $accepted = $dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK
    $result = if ($accepted) { [string]$password.Text } else { $null }
    $password.Clear()
    $dialog.Dispose()
    $result
}

function Close-AdminSession {
    if ($script:adminToken -and $script:adminServer) {
        try {
            $uri = (Convert-HubServerToHttp $script:adminServer) + '/api/management/session'
            Invoke-RestMethod -Method Delete -Uri $uri -Headers @{ Authorization = 'Bearer ' + $script:adminToken } | Out-Null
        } catch {}
    }
    $script:adminToken = ''
    $script:adminServer = ''
    $script:adminIssuedAt = [DateTime]::MinValue
}

function Open-AdminSession {
    Close-AdminSession
    $credentialTarget = Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'AgentToken'
    $credential = Get-EawHubCredential -Target $credentialTarget
    if (-not $credential -or [string]::IsNullOrWhiteSpace($credential.Secret)) {
        throw (Get-EawUiText -Text 'Сначала зарегистрируйтесь или войдите в окне Desktop Agent.')
    }
    $me = Invoke-HubApiWithToken -Method Get -Route '/api/auth/me' -Token $credential.Secret
    $roles = @($me.user.roles)
    $allowed = if ($TeamManagement) {
        $roles -contains 'admin' -or $roles -contains 'senior translator'
    } else {
        $roles -contains 'admin'
    }
    if (-not $allowed) { throw (Get-EawUiText -Text 'У сохранённой учётной записи нет роли для управления командой.') }
    $password = Read-AdminPassword ([string]$me.user.displayName)
    if ($null -eq $password) { throw (Get-EawUiText -Text 'Вход администратора отменён.') }
    try {
        $session = Invoke-HubApiWithToken -Method Post -Route '/api/management/session' `
            -Token $credential.Secret -Body @{ password = $password }
    } finally {
        $password = $null
    }
    $script:adminToken = [string]$session.token
    $script:adminServer = $serverBox.Text.Trim()
    $script:adminIssuedAt = [DateTime]::UtcNow
    $script:managerUser = $session.user
    $form.Text = if ($TeamManagement) {
        (Get-EawUiText -Text 'EaW Localisation Hub 0.8.8F8 – Управление командой')
    } else {
        (Get-EawUiText -Text 'EaW Localisation Hub 0.8.8F8 – Администратор')
    }
}

function Ensure-AdminSession([switch]$Fresh) {
    $serverChanged = $script:adminServer -cne $serverBox.Text.Trim()
    $tooOldForSensitiveAction = $Fresh -and ([DateTime]::UtcNow - $script:adminIssuedAt).TotalSeconds -ge 100
    if (-not $script:adminToken -or $serverChanged -or $tooOldForSensitiveAction) {
        Open-AdminSession
    }
}

function Invoke-HubAdminApi {
    param([string]$Method, [string]$Route, $Body = $null, [switch]$Fresh)
    Ensure-AdminSession -Fresh:$Fresh
    try {
        Invoke-HubApiWithToken -Method $Method -Route $Route -Token $script:adminToken -Body $Body
    } catch {
        $statusCode = 0
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
        if ($statusCode -ne 401) { throw }
        Open-AdminSession
        Invoke-HubApiWithToken -Method $Method -Route $Route -Token $script:adminToken -Body $Body
    }
}

function Set-Status([string]$Text) {
    $status.Text = $Text
    $form.Refresh()
}

function Refresh-BackupCredential {
    $issued = Invoke-HubAdminApi -Method Post -Route '/api/admin/backup-token' -Fresh
    $token = [string]$issued.token
    if ($token -notmatch '^eaw_backup_') { throw (Get-EawUiText -Text 'Сервер не вернул токен резервного копирования.') }
    $target = Get-EawHubCredentialTarget -Server $serverBox.Text.Trim() -Kind 'BackupToken'
    Set-EawHubCredential -Target $target -UserName 'EaW Hub scheduled backup' -Secret $token
    $target
}

function Save-BackupPassphrase {
    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = (Get-EawUiText -Text 'Пароль резервных копий')
    $dialog.Size = [System.Drawing.Size]::new(470, 225)
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $dialog.StartPosition = 'CenterParent'
    $description = [System.Windows.Forms.Label]::new()
    $description.Text = (Get-EawUiText -Text 'Минимум 12 символов. Потерянный пароль восстановить нельзя.')
    $description.AutoSize = $true
    $description.Location = [System.Drawing.Point]::new(20, 18)
    $dialog.Controls.Add($description)
    $first = [System.Windows.Forms.TextBox]::new()
    $first.UseSystemPasswordChar = $true
    $first.Location = [System.Drawing.Point]::new(20, 55)
    $first.Size = [System.Drawing.Size]::new(410, 24)
    $dialog.Controls.Add($first)
    $second = [System.Windows.Forms.TextBox]::new()
    $second.UseSystemPasswordChar = $true
    $second.Location = [System.Drawing.Point]::new(20, 91)
    $second.Size = [System.Drawing.Size]::new(410, 24)
    $dialog.Controls.Add($second)
    $ok = [System.Windows.Forms.Button]::new()
    $ok.Text = (Get-EawUiText -Text 'Сохранить')
    $ok.Location = [System.Drawing.Point]::new(238, 135)
    $ok.Size = [System.Drawing.Size]::new(92, 31)
    $dialog.Controls.Add($ok)
    $cancel = [System.Windows.Forms.Button]::new()
    $cancel.Text = (Get-EawUiText -Text 'Отмена')
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.Location = [System.Drawing.Point]::new(338, 135)
    $cancel.Size = [System.Drawing.Size]::new(92, 31)
    $dialog.Controls.Add($cancel)
    $dialog.CancelButton = $cancel
    $ok.Add_Click({
        if ($first.Text.Length -lt 12) {
            [void][System.Windows.Forms.MessageBox]::Show((Get-EawUiText -Text 'Пароль должен содержать минимум 12 символов.'), 'EaW Hub', 'OK', 'Warning')
            return
        }
        if ($first.Text -cne $second.Text) {
            [void][System.Windows.Forms.MessageBox]::Show((Get-EawUiText -Text 'Пароли не совпадают.'), 'EaW Hub', 'OK', 'Warning')
            return
        }
        Set-EawHubCredential -Target $passphraseTarget -UserName 'EaW Hub backup encryption' -Secret $first.Text
        $first.Clear()
        $second.Clear()
        $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $dialog.Close()
    })
    $saved = $dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK
    $dialog.Dispose()
    $saved
}

function Show-TemporaryPasswordDialog([string]$DisplayName) {
    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = (Get-EawUiText -Text 'Временный пароль: {0}' -Values @($DisplayName))
    $dialog.Size = [System.Drawing.Size]::new(520, 300)
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false
    $dialog.MinimizeBox = $false
    $dialog.StartPosition = 'CenterParent'
    $notice = [System.Windows.Forms.Label]::new()
    $notice.Text = (Get-EawUiText -Text 'Пароль будет виден только сейчас. Передайте его доверенным каналом. После первого входа пользователь обязан заменить его.')
    $notice.ForeColor = [System.Drawing.Color]::DarkRed
    $notice.Location = [System.Drawing.Point]::new(20, 18)
    $notice.Size = [System.Drawing.Size]::new(465, 48)
    $dialog.Controls.Add($notice)
    $first = [System.Windows.Forms.TextBox]::new()
    $first.UseSystemPasswordChar = $true
    $first.Location = [System.Drawing.Point]::new(20, 82)
    $first.Size = [System.Drawing.Size]::new(355, 24)
    $dialog.Controls.Add($first)
    $generate = [System.Windows.Forms.Button]::new()
    $generate.Text = (Get-EawUiText -Text 'Сгенерировать')
    $generate.Location = [System.Drawing.Point]::new(385, 79)
    $generate.Size = [System.Drawing.Size]::new(105, 30)
    $dialog.Controls.Add($generate)
    $second = [System.Windows.Forms.TextBox]::new()
    $second.UseSystemPasswordChar = $true
    $second.Location = [System.Drawing.Point]::new(20, 123)
    $second.Size = [System.Drawing.Size]::new(470, 24)
    $dialog.Controls.Add($second)
    $show = [System.Windows.Forms.CheckBox]::new()
    $show.Text = (Get-EawUiText -Text 'Показать пароль')
    $show.AutoSize = $true
    $show.Location = [System.Drawing.Point]::new(20, 158)
    $dialog.Controls.Add($show)
    $save = [System.Windows.Forms.Button]::new()
    $save.Text = (Get-EawUiText -Text 'Установить')
    $save.Location = [System.Drawing.Point]::new(286, 200)
    $save.Size = [System.Drawing.Size]::new(98, 32)
    $dialog.Controls.Add($save)
    $cancel = [System.Windows.Forms.Button]::new()
    $cancel.Text = (Get-EawUiText -Text 'Отмена')
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.Location = [System.Drawing.Point]::new(392, 200)
    $cancel.Size = [System.Drawing.Size]::new(98, 32)
    $dialog.Controls.Add($cancel)
    $dialog.CancelButton = $cancel
    $show.Add_CheckedChanged({
        $first.UseSystemPasswordChar = -not $show.Checked
        $second.UseSystemPasswordChar = -not $show.Checked
    })
    $generate.Add_Click({
        $bytes = [byte[]]::new(24)
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $value = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $first.Text = $value
        $second.Text = $value
        $show.Checked = $true
    })
    $script:temporaryPasswordResult = $null
    $save.Add_Click({
        if ($first.Text.Length -lt 12) {
            [void][System.Windows.Forms.MessageBox]::Show((Get-EawUiText -Text 'Пароль должен содержать минимум 12 символов.'), 'EaW Hub', 'OK', 'Warning')
            return
        }
        if ($first.Text -cne $second.Text) {
            [void][System.Windows.Forms.MessageBox]::Show((Get-EawUiText -Text 'Пароли не совпадают.'), 'EaW Hub', 'OK', 'Warning')
            return
        }
        $script:temporaryPasswordResult = $first.Text
        $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $dialog.Close()
    })
    [void]$dialog.ShowDialog($form)
    $result = $script:temporaryPasswordResult
    $script:temporaryPasswordResult = $null
    $first.Clear(); $second.Clear(); $dialog.Dispose()
    $result
}

function Refresh-Users {
    Set-Status (Get-EawUiText -Text 'Загрузка списка пользователей…')
    $result = Invoke-HubAdminApi -Method Get -Route '/api/management/users'
    $script:userRows = @($result.users)
    $users.Items.Clear()
    foreach ($user in $script:userRows) {
        $item = [System.Windows.Forms.ListViewItem]::new([string]$user.displayName)
        [void]$item.SubItems.Add((@($user.roles) -join ', '))
        [void]$item.SubItems.Add($(if ($user.enabled) { (Get-EawUiText -Text 'включён') } else { (Get-EawUiText -Text 'отключён') }))
        [void]$item.SubItems.Add($(if ($user.temporaryPassword) { (Get-EawUiText -Text 'временный') } elseif ($user.passwordSet) { (Get-EawUiText -Text 'да') } else { (Get-EawUiText -Text 'нет') }))
        $recoveryNames = @{
            active = (Get-EawUiText -Text 'активен'); setup_required = (Get-EawUiText -Text 'нужно сохранить'); pending_confirmation = (Get-EawUiText -Text 'не подтверждён')
            admin_authorization_required = (Get-EawUiText -Text 'нужно разрешение'); issuance_authorized = (Get-EawUiText -Text 'выдача разрешена')
        }
        [void]$item.SubItems.Add([string]$recoveryNames[[string]$user.recoveryStatus])
        $item.Tag = [string]$user.id
        if (-not $user.enabled) { $item.ForeColor = [System.Drawing.Color]::Gray }
        [void]$users.Items.Add($item)
    }
    Set-Status (Get-EawUiText -Text 'Загружено пользователей: {0}.' -Values @($($script:userRows.Count)))
}

function Show-InvitationsDialog {
    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = (Get-EawUiText -Text 'Приглашения и коды активации')
    $dialog.Size = [System.Drawing.Size]::new(900, 520)
    $dialog.MinimumSize = [System.Drawing.Size]::new(900, 520)
    $dialog.StartPosition = 'CenterParent'
    $list = [System.Windows.Forms.ListView]::new()
    $list.Location = [System.Drawing.Point]::new(15, 15)
    $list.Size = [System.Drawing.Size]::new(850, 370)
    $list.Anchor = 'Top, Bottom, Left, Right'
    $list.View = 'Details'
    $list.FullRowSelect = $true
    $list.MultiSelect = $false
    $list.GridLines = $true
    [void]$list.Columns.Add((Get-EawUiText -Text 'Статус'), 100)
    [void]$list.Columns.Add((Get-EawUiText -Text 'Роли'), 270)
    [void]$list.Columns.Add((Get-EawUiText -Text 'Использовано'), 100)
    [void]$list.Columns.Add((Get-EawUiText -Text 'Осталось'), 90)
    [void]$list.Columns.Add((Get-EawUiText -Text 'Истекает'), 230)
    $dialog.Controls.Add($list)
    $action = [System.Windows.Forms.Button]::new()
    $action.Text = (Get-EawUiText -Text 'Отозвать выбранное')
    $action.Location = [System.Drawing.Point]::new(530, 400)
    $action.Size = [System.Drawing.Size]::new(175, 32)
    $action.Anchor = 'Bottom, Right'
    $dialog.Controls.Add($action)
    $close = [System.Windows.Forms.Button]::new()
    $close.Text = (Get-EawUiText -Text 'Закрыть')
    $close.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $close.Location = [System.Drawing.Point]::new(715, 400)
    $close.Size = [System.Drawing.Size]::new(150, 32)
    $close.Anchor = 'Bottom, Right'
    $dialog.Controls.Add($close)
    $dialog.CancelButton = $close
    $statusNames = @{ active = (Get-EawUiText -Text 'активно'); expired = (Get-EawUiText -Text 'истекло'); exhausted = (Get-EawUiText -Text 'исчерпано'); revoked = (Get-EawUiText -Text 'отозвано') }
    $refreshInvites = {
        $result = Invoke-HubAdminApi -Method Get -Route '/api/management/invites'
        $list.Items.Clear()
        foreach ($invite in @($result.invites)) {
            $item = [System.Windows.Forms.ListViewItem]::new([string]$statusNames[[string]$invite.status])
            [void]$item.SubItems.Add((@($invite.roles) -join ', '))
            [void]$item.SubItems.Add((Get-EawUiText -Text '{0} из {1}' -Values @($($invite.uses), $($invite.maxUses))))
            [void]$item.SubItems.Add([string]$invite.remainingUses)
            $expires = [DateTimeOffset]::Parse([string]$invite.expiresAt).ToLocalTime().ToString('dd.MM.yyyy HH:mm')
            [void]$item.SubItems.Add($expires)
            $item.Tag = $invite
            [void]$list.Items.Add($item)
        }
    }
    $list.Add_SelectedIndexChanged({
        if ($list.SelectedItems.Count -ne 1) { return }
        $invite = $list.SelectedItems[0].Tag
        $action.Text = if ([string]$invite.status -eq 'active') { (Get-EawUiText -Text 'Отозвать выбранное') } else { (Get-EawUiText -Text 'Удалить запись') }
    })
    $action.Add_Click({
        try {
            if ($list.SelectedItems.Count -ne 1) { throw (Get-EawUiText -Text 'Сначала выберите приглашение.') }
            $invite = $list.SelectedItems[0].Tag
            $id = [Uri]::EscapeDataString([string]$invite.id)
            if ([string]$invite.status -eq 'active') {
                [void](Invoke-HubAdminApi -Method Post -Fresh -Route "/api/management/invites/$id/revoke")
            } else {
                [void](Invoke-HubAdminApi -Method Delete -Fresh -Route "/api/management/invites/$id")
            }
            & $refreshInvites
        } catch {
            [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, (Get-EawUiText -Text 'Приглашение не изменено'), 'OK', 'Warning')
        }
    })
    & $refreshInvites
    [void]$dialog.ShowDialog($form)
    $dialog.Dispose()
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = [System.Windows.Forms.Form]::new()
$form.Text = if ($TeamManagement) { (Get-EawUiText -Text 'EaW Localisation Hub 0.8.8F8 – Управление командой') } else { (Get-EawUiText -Text 'EaW Localisation Hub 0.8.8F8 – Администратор') }
$form.Size = [System.Drawing.Size]::new(900, 790)
$form.MinimumSize = [System.Drawing.Size]::new(900, 790)
$form.StartPosition = 'CenterScreen'

$serverLabel = [System.Windows.Forms.Label]::new()
$serverLabel.Text = (Get-EawUiText -Text 'Сервер:')
$serverLabel.AutoSize = $true
$serverLabel.Location = [System.Drawing.Point]::new(20, 24)
$form.Controls.Add($serverLabel)
$serverBox = [System.Windows.Forms.TextBox]::new()
$serverBox.Text = Read-AgentServer
$serverBox.Location = [System.Drawing.Point]::new(90, 20)
$serverBox.Size = [System.Drawing.Size]::new(615, 24)
$form.Controls.Add($serverBox)
$refreshButton = [System.Windows.Forms.Button]::new()
$refreshButton.Text = (Get-EawUiText -Text 'Обновить')
$refreshButton.Location = [System.Drawing.Point]::new(720, 18)
$refreshButton.Size = [System.Drawing.Size]::new(135, 29)
$form.Controls.Add($refreshButton)

$usersLabel = [System.Windows.Forms.Label]::new()
$usersLabel.Text = (Get-EawUiText -Text 'Пользователи')
$usersLabel.AutoSize = $true
$usersLabel.Location = [System.Drawing.Point]::new(20, 67)
$form.Controls.Add($usersLabel)
$users = [System.Windows.Forms.ListView]::new()
$users.Location = [System.Drawing.Point]::new(20, 90)
$users.Size = [System.Drawing.Size]::new(840, 245)
$users.View = 'Details'
$users.FullRowSelect = $true
$users.MultiSelect = $false
$users.GridLines = $true
[void]$users.Columns.Add((Get-EawUiText -Text 'Имя'), 220)
[void]$users.Columns.Add((Get-EawUiText -Text 'Роли'), 220)
[void]$users.Columns.Add((Get-EawUiText -Text 'Доступ'), 90)
[void]$users.Columns.Add((Get-EawUiText -Text 'Пароль'), 115)
[void]$users.Columns.Add((Get-EawUiText -Text 'Восстановление'), 185)
$form.Controls.Add($users)

$toggleEnabledButton = [System.Windows.Forms.Button]::new()
$toggleEnabledButton.Text = (Get-EawUiText -Text 'Отключить')
$toggleEnabledButton.Location = [System.Drawing.Point]::new(20, 345)
$toggleEnabledButton.Size = [System.Drawing.Size]::new(150, 32)
$form.Controls.Add($toggleEnabledButton)

$deleteButton = [System.Windows.Forms.Button]::new()
$deleteButton.Text = (Get-EawUiText -Text 'Удалить навсегда')
$deleteButton.Location = [System.Drawing.Point]::new(180, 345)
$deleteButton.Size = [System.Drawing.Size]::new(150, 32)
$form.Controls.Add($deleteButton)

$editRolesButton = [System.Windows.Forms.Button]::new()
$editRolesButton.Text = (Get-EawUiText -Text 'Изменить роли…')
$editRolesButton.Location = [System.Drawing.Point]::new(340, 345)
$editRolesButton.Size = [System.Drawing.Size]::new(130, 32)
$form.Controls.Add($editRolesButton)

$recoveryAuthorizeButton = [System.Windows.Forms.Button]::new()
$recoveryAuthorizeButton.Text = (Get-EawUiText -Text 'Разрешить новый код восстановления')
$recoveryAuthorizeButton.Location = [System.Drawing.Point]::new(480, 345)
$recoveryAuthorizeButton.Size = [System.Drawing.Size]::new(220, 32)
$form.Controls.Add($recoveryAuthorizeButton)
$temporaryPasswordButton = [System.Windows.Forms.Button]::new()
$temporaryPasswordButton.Text = (Get-EawUiText -Text 'Временный пароль…')
$temporaryPasswordButton.Location = [System.Drawing.Point]::new(710, 345)
$temporaryPasswordButton.Size = [System.Drawing.Size]::new(150, 32)
$form.Controls.Add($temporaryPasswordButton)

$inviteGroup = [System.Windows.Forms.GroupBox]::new()
$inviteGroup.Text = (Get-EawUiText -Text 'Новое приглашение')
$inviteGroup.Location = [System.Drawing.Point]::new(20, 390)
$inviteGroup.Size = [System.Drawing.Size]::new(550, 230)
$form.Controls.Add($inviteGroup)
$inviteRoles = [System.Windows.Forms.CheckedListBox]::new()
$inviteRoles.CheckOnClick = $true
$inviteRoles.Location = [System.Drawing.Point]::new(15, 27)
$inviteRoles.Size = [System.Drawing.Size]::new(230, 94)
$roleOptions = if ($TeamManagement) { @('senior translator', 'translator', 'trainee-translator', 'translation-editor', 'mod-contributor') } else { @('admin', 'senior translator', 'translator', 'trainee-translator', 'translation-editor', 'mod-contributor') }
$roleOptions | ForEach-Object {
    [void]$inviteRoles.Items.Add($_, ($_ -eq 'translator'))
}
$inviteGroup.Controls.Add($inviteRoles)
$usesBox = [System.Windows.Forms.NumericUpDown]::new()
$usesBox.Minimum = 1
$usesBox.Maximum = 30
$usesBox.Value = 1
$usesBox.Location = [System.Drawing.Point]::new(270, 28)
$usesBox.Size = [System.Drawing.Size]::new(70, 24)
$inviteGroup.Controls.Add($usesBox)
$usesLabel = [System.Windows.Forms.Label]::new()
$usesLabel.Text = (Get-EawUiText -Text 'исп.')
$usesLabel.AutoSize = $true
$usesLabel.Location = [System.Drawing.Point]::new(343, 32)
$inviteGroup.Controls.Add($usesLabel)
$hoursBox = [System.Windows.Forms.NumericUpDown]::new()
$hoursBox.Minimum = 1
$hoursBox.Maximum = 720
$hoursBox.Value = 72
$hoursBox.Location = [System.Drawing.Point]::new(390, 28)
$hoursBox.Size = [System.Drawing.Size]::new(75, 24)
$inviteGroup.Controls.Add($hoursBox)
$hoursLabel = [System.Windows.Forms.Label]::new()
$hoursLabel.Text = (Get-EawUiText -Text 'час.')
$hoursLabel.AutoSize = $true
$hoursLabel.Location = [System.Drawing.Point]::new(468, 32)
$inviteGroup.Controls.Add($hoursLabel)
$createInviteButton = [System.Windows.Forms.Button]::new()
$createInviteButton.Text = (Get-EawUiText -Text 'Создать')
$createInviteButton.Location = [System.Drawing.Point]::new(270, 72)
$createInviteButton.Size = [System.Drawing.Size]::new(220, 32)
$inviteGroup.Controls.Add($createInviteButton)
$inviteResult = [System.Windows.Forms.TextBox]::new()
$inviteResult.ReadOnly = $true
$inviteResult.Location = [System.Drawing.Point]::new(15, 145)
$inviteResult.Size = [System.Drawing.Size]::new(390, 25)
$inviteGroup.Controls.Add($inviteResult)
$copyInviteButton = [System.Windows.Forms.Button]::new()
$copyInviteButton.Text = (Get-EawUiText -Text 'Копировать')
$copyInviteButton.Location = [System.Drawing.Point]::new(415, 142)
$copyInviteButton.Size = [System.Drawing.Size]::new(115, 30)
$inviteGroup.Controls.Add($copyInviteButton)
$manageInvitesButton = [System.Windows.Forms.Button]::new()
$manageInvitesButton.Text = (Get-EawUiText -Text 'Просмотреть приглашения…')
$manageInvitesButton.Location = [System.Drawing.Point]::new(270, 108)
$manageInvitesButton.Size = [System.Drawing.Size]::new(220, 30)
$inviteGroup.Controls.Add($manageInvitesButton)
$inviteHint = [System.Windows.Forms.Label]::new()
$inviteHint.Text = (Get-EawUiText -Text 'Код показывается только при создании. В списке видны роли, срок и остаток активаций.')
$inviteHint.Location = [System.Drawing.Point]::new(15, 184)
$inviteHint.Size = [System.Drawing.Size]::new(515, 32)
$inviteGroup.Controls.Add($inviteHint)

$backupGroup = [System.Windows.Forms.GroupBox]::new()
$backupGroup.Text = (Get-EawUiText -Text 'Резервная копия на этом ПК')
$backupGroup.Location = [System.Drawing.Point]::new(585, 390)
$backupGroup.Size = [System.Drawing.Size]::new(275, 230)
$form.Controls.Add($backupGroup)
$setPassphraseButton = [System.Windows.Forms.Button]::new()
$setPassphraseButton.Text = (Get-EawUiText -Text 'Задать пароль копий')
$setPassphraseButton.Location = [System.Drawing.Point]::new(15, 28)
$setPassphraseButton.Size = [System.Drawing.Size]::new(235, 31)
$backupGroup.Controls.Add($setPassphraseButton)
$backupButton = [System.Windows.Forms.Button]::new()
$backupButton.Text = (Get-EawUiText -Text 'Создать копию сейчас')
$backupButton.Location = [System.Drawing.Point]::new(15, 70)
$backupButton.Size = [System.Drawing.Size]::new(235, 31)
$backupGroup.Controls.Add($backupButton)
$scheduleBackupButton = [System.Windows.Forms.Button]::new()
$scheduleBackupButton.Text = (Get-EawUiText -Text 'Ежедневно в 03:00')
$scheduleBackupButton.Location = [System.Drawing.Point]::new(15, 112)
$scheduleBackupButton.Size = [System.Drawing.Size]::new(235, 31)
$backupGroup.Controls.Add($scheduleBackupButton)
$backupGroup.Visible = -not $TeamManagement
if (-not $TeamManagement) {
    . (Join-Path $PSScriptRoot 'admin-audit-ui.ps1')
    $auditButton = [System.Windows.Forms.Button]::new()
    $auditButton.Text = (Get-EawUiText -Text 'Журнал действий…')
    $auditButton.Location = [System.Drawing.Point]::new(685, 54)
    $auditButton.Size = [System.Drawing.Size]::new(175, 29)
    $form.Controls.Add($auditButton)
    $auditButton.Add_Click({
        try { Show-EawAuditDialog -Owner $form } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
    })
}

$status = [System.Windows.Forms.Label]::new()
$status.Text = (Get-EawUiText -Text 'Для управления нужен сохранённый вход с подходящей ролью и повторный ввод пароля.')
$status.BorderStyle = 'FixedSingle'
$status.Location = [System.Drawing.Point]::new(20, 650)
$status.Size = [System.Drawing.Size]::new(840, 56)
$status.TextAlign = 'MiddleLeft'
$form.Controls.Add($status)

$refreshButton.Add_Click({ try { Refresh-Users } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) } })
$createInviteButton.Add_Click({
    try {
        Set-Status (Get-EawUiText -Text 'Создание приглашения…')
        $selectedRoles = @($inviteRoles.CheckedItems | ForEach-Object { [string]$_ })
        if ($selectedRoles.Count -eq 0) { throw (Get-EawUiText -Text 'Выберите хотя бы одну роль.') }
        $result = Invoke-HubAdminApi -Method Post -Route '/api/management/invites' -Fresh -Body @{
            roles = $selectedRoles
            maxUses = [int]$usesBox.Value
            expiresInHours = [int]$hoursBox.Value
        }
        $inviteResult.Text = [string]$result.code
        Set-Status (Get-EawUiText -Text 'Приглашение создано. Передайте код нужному участнику через доверенный канал.')
    } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
})
$copyInviteButton.Add_Click({
    if ($inviteResult.Text) {
        [System.Windows.Forms.Clipboard]::SetText($inviteResult.Text)
        Set-Status (Get-EawUiText -Text 'Код приглашения скопирован.')
    }
})
$users.Add_SelectedIndexChanged({
    if ($users.SelectedItems.Count -ne 1) { return }
    $user = $script:userRows | Where-Object { [string]$_.id -eq [string]$users.SelectedItems[0].Tag } | Select-Object -First 1
    if ($user) { $toggleEnabledButton.Text = if ($user.enabled) { (Get-EawUiText -Text 'Отключить') } else { (Get-EawUiText -Text 'Включить') } }
})
$toggleEnabledButton.Add_Click({
    try {
        if ($users.SelectedItems.Count -ne 1) { throw (Get-EawUiText -Text 'Сначала выберите пользователя.') }
        $selected = $users.SelectedItems[0]
        $user = $script:userRows | Where-Object { [string]$_.id -eq [string]$selected.Tag } | Select-Object -First 1
        $operation = if ($user.enabled) { 'disable' } else { 'enable' }
        [void](Invoke-HubAdminApi -Method Post -Fresh -Route ('/api/management/users/' + [Uri]::EscapeDataString([string]$selected.Tag) + "/$operation"))
        Refresh-Users
    } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
})
$deleteButton.Add_Click({
    try {
        if ($users.SelectedItems.Count -ne 1) { throw (Get-EawUiText -Text 'Сначала выберите пользователя.') }
        $selected = $users.SelectedItems[0]
        $answer = [System.Windows.Forms.MessageBox]::Show(
            (Get-EawUiText -Text 'БЕЗВОЗВРАТНО удалить аккаунт «{0}», все его сессии и коды восстановления? Для временного ухода используйте отключение.' -Values @($($selected.Text))),
            (Get-EawUiText -Text 'Безвозвратное удаление'),
            'YesNo',
            'Warning')
        if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
        [void](Invoke-HubAdminApi -Method Delete -Fresh -Route ('/api/management/users/' + [Uri]::EscapeDataString([string]$selected.Tag)))
        Refresh-Users
    } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
})
$editRolesButton.Add_Click({
    try {
        if ($users.SelectedItems.Count -ne 1) { throw (Get-EawUiText -Text 'Сначала выберите пользователя.') }
        $selected = $users.SelectedItems[0]
        $user = $script:userRows | Where-Object { [string]$_.id -eq [string]$selected.Tag } | Select-Object -First 1
        if (-not $user) { throw (Get-EawUiText -Text 'Пользователь больше не найден. Обновите список.') }

        $dialog = [System.Windows.Forms.Form]::new()
        $dialog.Text = (Get-EawUiText -Text 'Роли: {0}' -Values @($($user.displayName)))
        $dialog.Size = [System.Drawing.Size]::new(385, 330)
        $dialog.FormBorderStyle = 'FixedDialog'
        $dialog.MaximizeBox = $false
        $dialog.MinimizeBox = $false
        $dialog.StartPosition = 'CenterParent'
        $roleList = [System.Windows.Forms.CheckedListBox]::new()
        $roleList.CheckOnClick = $true
        $roleList.Location = [System.Drawing.Point]::new(20, 20)
        $roleList.Size = [System.Drawing.Size]::new(330, 165)
        $roleOptions | ForEach-Object {
            [void]$roleList.Items.Add($_, (@($user.roles) -contains $_))
        }
        $dialog.Controls.Add($roleList)
        $saveRoles = [System.Windows.Forms.Button]::new()
        $saveRoles.Text = (Get-EawUiText -Text 'Сохранить')
        $saveRoles.Location = [System.Drawing.Point]::new(150, 215)
        $saveRoles.Size = [System.Drawing.Size]::new(95, 32)
        $dialog.Controls.Add($saveRoles)
        $cancelRoles = [System.Windows.Forms.Button]::new()
        $cancelRoles.Text = (Get-EawUiText -Text 'Отмена')
        $cancelRoles.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $cancelRoles.Location = [System.Drawing.Point]::new(255, 215)
        $cancelRoles.Size = [System.Drawing.Size]::new(95, 32)
        $dialog.Controls.Add($cancelRoles)
        $dialog.CancelButton = $cancelRoles
        $saveRoles.Add_Click({
            try {
                $roles = @($roleList.CheckedItems | ForEach-Object { [string]$_ })
                if ($roles.Count -eq 0) { throw (Get-EawUiText -Text 'Выберите хотя бы одну роль.') }
                [void](Invoke-HubAdminApi -Method Put -Fresh `
                    -Route ('/api/management/users/' + [Uri]::EscapeDataString([string]$user.id) + '/roles') `
                    -Body @{ roles = $roles })
                $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $dialog.Close()
            } catch {
                [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, (Get-EawUiText -Text 'Роли не сохранены'), 'OK', 'Warning')
            }
        })
        if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
            Refresh-Users
        }
        $dialog.Dispose()
    } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
})
$recoveryAuthorizeButton.Add_Click({
    try {
        if ($users.SelectedItems.Count -ne 1) { throw (Get-EawUiText -Text 'Сначала выберите пользователя.') }
        $selected = $users.SelectedItems[0]
        $answer = [System.Windows.Forms.MessageBox]::Show(
            (Get-EawUiText -Text 'Разрешить «{0}» получить новый код восстановления? Действующий код будет аннулирован. Сам новый код администратору показан не будет.' -Values @($($selected.Text))),
            (Get-EawUiText -Text 'Новый код восстановления'),
            'YesNo',
            'Question')
        if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
        [void](Invoke-HubAdminApi -Method Post -Fresh `
            -Route ('/api/management/users/' + [Uri]::EscapeDataString([string]$selected.Tag) + '/recovery-authorize'))
        Refresh-Users
        Set-Status (Get-EawUiText -Text 'Выдача разрешена. Пользователь увидит красную плашку и сохранит код сам; администратор код не получает.')
    } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
})
$temporaryPasswordButton.Add_Click({
    try {
        if ($users.SelectedItems.Count -ne 1) { throw (Get-EawUiText -Text 'Сначала выберите пользователя.') }
        $selected = $users.SelectedItems[0]
        $temporaryPassword = Show-TemporaryPasswordDialog ([string]$selected.Text)
        if ([string]::IsNullOrEmpty($temporaryPassword)) { return }
        [void](Invoke-HubAdminApi -Method Post -Fresh `
            -Route ('/api/management/users/' + [Uri]::EscapeDataString([string]$selected.Tag) + '/temporary-password') `
            -Body @{ temporaryPassword = $temporaryPassword })
        $temporaryPassword = $null
        Refresh-Users
        Set-Status (Get-EawUiText -Text 'Временный пароль установлен. Все прежние сессии завершены; после входа пользователь обязан сменить пароль.')
    } catch {
        $temporaryPassword = $null
        Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message)))
    }
})
$manageInvitesButton.Add_Click({
    try { Show-InvitationsDialog } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
})
$setPassphraseButton.Add_Click({
    try {
        if (Save-BackupPassphrase) {
            Set-Status (Get-EawUiText -Text 'Пароль резервных копий сохранён в Windows Credential Manager.')
        }
    } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
})
$backupButton.Add_Click({
    try {
        Set-Status (Get-EawUiText -Text 'Создание зашифрованной резервной копии…')
        Ensure-AdminSession -Fresh
        $server = $serverBox.Text.Trim()
        $backupCredentialTarget = Get-EawHubCredentialTarget -Server $server -Kind 'BackupToken'
        if (-not (Get-EawHubCredential -Target $backupCredentialTarget)) {
            $backupCredentialTarget = Refresh-BackupCredential
        }
        try {
            $result = & (Join-Path $PSScriptRoot 'backup-server.ps1') `
                -Server $server -CredentialTarget $backupCredentialTarget
        } catch {
            if ($_.Exception.Message -notmatch '\b401\b') { throw }
            $backupCredentialTarget = Refresh-BackupCredential
            $result = & (Join-Path $PSScriptRoot 'backup-server.ps1') `
                -Server $server -CredentialTarget $backupCredentialTarget
        }
        Set-Status (Get-EawUiText -Text 'Резервная копия создана: {0}' -Values @($($result.Backup)))
    } catch {
        Set-Status (Get-EawUiText -Text 'Ошибка создания копии: {0}' -Values @($($_.Exception.Message)))
        [void][System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message, (Get-EawUiText -Text 'Резервная копия не создана'), 'OK', 'Error')
    }
})
$scheduleBackupButton.Add_Click({
    try {
        [void](Refresh-BackupCredential)
        $result = & (Join-Path $PSScriptRoot 'install-backup-task.ps1') -Server $serverBox.Text.Trim()
        Set-Status $result
    } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) }
})

$form.Add_Shown({ try { Refresh-Users } catch { Set-Status (Get-EawUiText -Text 'Ошибка: {0}' -Values @($($_.Exception.Message))) } })
$form.Add_FormClosing({ Close-AdminSession })
[void]$form.ShowDialog()
