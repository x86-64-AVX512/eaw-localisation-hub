$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class EawHubLauncherWindow {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr handle, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr handle);
}
'@
. (Join-Path $PSScriptRoot 'local-prototype-common.ps1')
$paths = Get-LocalPrototypePaths

$saved = $null
if (Test-Path -LiteralPath $paths.ConfigPath) {
    try { $saved = Get-Content -LiteralPath $paths.ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { $saved = $null }
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'EaW Localisation Hub 0.8.6F4'
$form.Size = [System.Drawing.Size]::new(600, 585)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Add_Shown({
    [EawHubLauncherWindow]::ShowWindow($form.Handle, 5) | Out-Null
    [EawHubLauncherWindow]::SetForegroundWindow($form.Handle) | Out-Null
    $form.Activate()
})

$title = [System.Windows.Forms.Label]::new()
$title.Text = 'Локальная лаборатория совместного редактирования'
$title.Font = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = [System.Drawing.Point]::new(24, 20)
$form.Controls.Add($title)

$description = [System.Windows.Forms.Label]::new()
$description.Text = "Откроются два изолированных Notepad++ с тестовыми копиями файла.`r`nРабочий репозиторий мода изменён не будет."
$description.AutoSize = $true
$description.Location = [System.Drawing.Point]::new(27, 58)
$form.Controls.Add($description)

$userLabel = [System.Windows.Forms.Label]::new()
$userLabel.Text = 'Первый участник:'
$userLabel.AutoSize = $true
$userLabel.Location = [System.Drawing.Point]::new(28, 112)
$form.Controls.Add($userLabel)

$userBox = [System.Windows.Forms.TextBox]::new()
$userBox.Location = [System.Drawing.Point]::new(180, 108)
$userBox.Size = [System.Drawing.Size]::new(370, 24)
$userBox.Text = if ($saved.User) { [string]$saved.User } else { [Environment]::UserName }
$form.Controls.Add($userBox)

$secondLabel = [System.Windows.Forms.Label]::new()
$secondLabel.Text = 'Второй участник:'
$secondLabel.AutoSize = $true
$secondLabel.Location = [System.Drawing.Point]::new(28, 151)
$form.Controls.Add($secondLabel)

$secondBox = [System.Windows.Forms.TextBox]::new()
$secondBox.Location = [System.Drawing.Point]::new(180, 147)
$secondBox.Size = [System.Drawing.Size]::new(370, 24)
$secondBox.Text = if ($saved.SecondUser) { [string]$saved.SecondUser } else { 'Тестовый переводчик' }
$form.Controls.Add($secondBox)

$workspaceLabel = [System.Windows.Forms.Label]::new()
$workspaceLabel.Text = 'Тестовая ветка:'
$workspaceLabel.AutoSize = $true
$workspaceLabel.Location = [System.Drawing.Point]::new(28, 190)
$form.Controls.Add($workspaceLabel)

$workspaceBox = [System.Windows.Forms.TextBox]::new()
$workspaceBox.Location = [System.Drawing.Point]::new(180, 186)
$workspaceBox.Size = [System.Drawing.Size]::new(370, 24)
$workspaceBox.Text = if ($saved.Workspace) { [string]$saved.Workspace } else { 'prototype-local' }
$form.Controls.Add($workspaceBox)

$authBox = [System.Windows.Forms.CheckBox]::new()
$authBox.Text = 'Защищённый режим (случайные тестовые пароли не сохраняются)'
$authBox.AutoSize = $true
$authBox.Location = [System.Drawing.Point]::new(28, 220)
$authBox.Checked = if ($null -ne $saved -and $null -ne $saved.ProtectedAuth) { [bool]$saved.ProtectedAuth } else { $true }
$form.Controls.Add($authBox)

$startButton = [System.Windows.Forms.Button]::new()
$startButton.Text = 'Запустить лабораторию'
$startButton.Location = [System.Drawing.Point]::new(28, 268)
$startButton.Size = [System.Drawing.Size]::new(185, 38)
$form.Controls.Add($startButton)

$stopButton = [System.Windows.Forms.Button]::new()
$stopButton.Text = 'Остановить'
$stopButton.Location = [System.Drawing.Point]::new(224, 268)
$stopButton.Size = [System.Drawing.Size]::new(130, 38)
$form.Controls.Add($stopButton)

$logsButton = [System.Windows.Forms.Button]::new()
$logsButton.Text = 'Папка журналов'
$logsButton.Location = [System.Drawing.Point]::new(365, 268)
$logsButton.Size = [System.Drawing.Size]::new(185, 38)
$form.Controls.Add($logsButton)

$resetButton = [System.Windows.Forms.Button]::new()
$resetButton.Text = 'Сбросить только тестовые данные'
$resetButton.Location = [System.Drawing.Point]::new(28, 321)
$resetButton.Size = [System.Drawing.Size]::new(522, 32)
$form.Controls.Add($resetButton)

$publishButton = [System.Windows.Forms.Button]::new()
$publishButton.Text = 'Git: новый коммит на сервере'
$publishButton.Location = [System.Drawing.Point]::new(28, 366)
$publishButton.Size = [System.Drawing.Size]::new(220, 32)
$publishButton.Enabled = $false
$form.Controls.Add($publishButton)

$syncAButton = [System.Windows.Forms.Button]::new()
$syncAButton.Text = 'Обновить Git участника 1'
$syncAButton.Location = [System.Drawing.Point]::new(258, 366)
$syncAButton.Size = [System.Drawing.Size]::new(142, 32)
$syncAButton.Enabled = $false
$form.Controls.Add($syncAButton)

$syncBButton = [System.Windows.Forms.Button]::new()
$syncBButton.Text = 'Обновить Git участника 2'
$syncBButton.Location = [System.Drawing.Point]::new(408, 366)
$syncBButton.Size = [System.Drawing.Size]::new(142, 32)
$syncBButton.Enabled = $false
$form.Controls.Add($syncBButton)

$statusLabel = [System.Windows.Forms.Label]::new()
$statusLabel.Text = 'Готово к запуску.'
$statusLabel.BorderStyle = 'FixedSingle'
$statusLabel.Location = [System.Drawing.Point]::new(28, 414)
$statusLabel.Size = [System.Drawing.Size]::new(522, 72)
$statusLabel.TextAlign = 'MiddleLeft'
$form.Controls.Add($statusLabel)

if (Test-Path -LiteralPath $paths.StatePath) {
    try {
        $currentState = Get-Content -LiteralPath $paths.StatePath -Raw -Encoding utf8 | ConvertFrom-Json
        $activeProcesses = @($currentState.Processes) | Where-Object {
            Test-OwnedProcess -Id ([int]$_.Id) -ExpectedExecutable ([string]$_.Executable) -CommandMarker ([string]$_.CommandMarker)
        }
        if ($activeProcesses.Count -gt 0) {
            $statusLabel.Text = "Лаборатория уже запущена.`r`nМожно перейти в два окна Notepad++."
            $startButton.Enabled = $false
            $resetButton.Enabled = $false
            $publishButton.Enabled = $true
            $syncAButton.Enabled = $true
            $syncBButton.Enabled = $true
        }
    }
    catch {
        $statusLabel.Text = 'Не удалось прочитать состояние предыдущего запуска.'
    }
}

$startButton.Add_Click({
    $startedSuccessfully = $false
    try {
        if ([string]::IsNullOrWhiteSpace($userBox.Text) -or [string]::IsNullOrWhiteSpace($secondBox.Text)) {
            throw 'Укажите имена обоих тестовых участников.'
        }
        if ($authBox.Checked -and $userBox.Text.Trim().Equals($secondBox.Text.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'В защищённом режиме участникам нужны разные имена учётных записей.'
        }
        if ($workspaceBox.Text -notmatch '^[A-Za-z0-9._-]+$') {
            throw 'Имя тестовой ветки может содержать только латинские буквы, цифры, точку, дефис и подчёркивание.'
        }
        $startButton.Enabled = $false
        $statusLabel.Text = 'Подготовка и запуск...'
        $form.Refresh()
        $result = & (Join-Path $PSScriptRoot 'start-local-prototype.ps1') `
            -User $userBox.Text -SecondUser $secondBox.Text -Workspace $workspaceBox.Text `
            -ProtectedAuth:$authBox.Checked
        $mode = if ($authBox.Checked) { 'Авторизация проверена.' } else { 'Авторизация отключена.' }
        $statusLabel.Text = "Запущено. Оба плагина подключены. $mode`r`nРедактируйте тестовый файл в двух окнах Notepad++."
        $startedSuccessfully = $true
        $resetButton.Enabled = $false
        $publishButton.Enabled = $true
        $syncAButton.Enabled = $true
        $syncBButton.Enabled = $true
    }
    catch {
        $statusLabel.Text = "Ошибка: $($_.Exception.Message)"
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'EaW Localisation Hub',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
    finally {
        $startButton.Enabled = -not $startedSuccessfully
    }
})

$stopButton.Add_Click({
    try {
        $stopButton.Enabled = $false
        $statusLabel.Text = 'Остановка...'
        $form.Refresh()
        & (Join-Path $PSScriptRoot 'stop-local-prototype.ps1') | Out-Null
        $statusLabel.Text = 'Локальная лаборатория остановлена.'
        $startButton.Enabled = $true
        $resetButton.Enabled = $true
        $publishButton.Enabled = $false
        $syncAButton.Enabled = $false
        $syncBButton.Enabled = $false
    }
    catch {
        $statusLabel.Text = "Требуется действие: $($_.Exception.Message)"
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'EaW Localisation Hub',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    }
    finally {
        $stopButton.Enabled = $true
    }
})

$logsButton.Add_Click({
    New-Item -ItemType Directory -Path $paths.LogsDirectory -Force | Out-Null
    Start-Process explorer.exe -ArgumentList (ConvertTo-ProcessArgument $paths.LogsDirectory)
})

function Invoke-GitLabAction {
    param([string]$Action, [string]$SuccessMessage)
    try {
        $publishButton.Enabled = $false
        $syncAButton.Enabled = $false
        $syncBButton.Enabled = $false
        $statusLabel.Text = 'Выполняется локальная Git-команда...'
        $form.Refresh()
        $result = & (Join-Path $PSScriptRoot 'local-prototype-git.ps1') -Action $Action -Branch $workspaceBox.Text
        $shortOrigin = ([string]$result.OriginCommit).Substring(0, 10)
        $statusLabel.Text = "$SuccessMessage`r`nHEAD локального origin: $shortOrigin"
    }
    catch {
        $statusLabel.Text = "Ошибка Git-теста: $($_.Exception.Message)"
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'EaW Localisation Hub',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
    finally {
        $publishButton.Enabled = $true
        $syncAButton.Enabled = $true
        $syncBButton.Enabled = $true
    }
}

$publishButton.Add_Click({
    Invoke-GitLabAction 'Publish' 'Сервер получил новый канонический коммит. Через 1–2 секунды оба Agent должны стать устаревшими.'
})

$syncAButton.Add_Click({
    Invoke-GitLabAction 'SyncA' 'Git первого участника обновлён. Agent переподключит документы автоматически.'
})

$syncBButton.Add_Click({
    Invoke-GitLabAction 'SyncB' 'Git второго участника обновлён. Agent переподключит документы автоматически.'
})

$resetButton.Add_Click({
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Будут удалены только две тестовые копии и тестовое состояние сервера.`r`nРабочий репозиторий EaW не затрагивается. Продолжить?",
        'EaW Localisation Hub',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    try {
        & (Join-Path $PSScriptRoot 'reset-local-prototype.ps1') | Out-Null
        $statusLabel.Text = 'Тестовые файлы и состояние сервера восстановлены.'
    }
    catch {
        $statusLabel.Text = "Ошибка сброса: $($_.Exception.Message)"
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'EaW Localisation Hub',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
})

[void]$form.ShowDialog()
