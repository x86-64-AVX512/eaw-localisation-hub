param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $projectRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
}
$deployerPath = Join-Path $projectRoot 'apps\deployer\src\main.mjs'
$version = ([IO.File]::ReadAllText((Join-Path $projectRoot 'VERSION'))).Trim()
$configRoot = Join-Path $env:LOCALAPPDATA 'EaWLocalisationHub'
$configPath = Join-Path $configRoot 'deployer.json'

function Load-Configuration {
    if (-not (Test-Path -LiteralPath $configPath)) { return $null }
    try { [IO.File]::ReadAllText($configPath) | ConvertFrom-Json } catch { $null }
}

function Save-Configuration([string]$Fingerprint) {
    New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
    $record = [ordered]@{
        Host = $hostBox.Text.Trim()
        Port = [int]$portBox.Value
        Username = $userBox.Text.Trim()
        RemoteRoot = $rootBox.Text.Trim()
        PrivateKeyPath = $keyBox.Text.Trim()
        HostFingerprint = $Fingerprint
    }
    [IO.File]::WriteAllText($configPath, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

function Add-Field($form, [string]$caption, [int]$top, [System.Windows.Forms.Control]$control) {
    $label = [Windows.Forms.Label]::new()
    $label.Text = $caption
    $label.Location = [Drawing.Point]::new(18, $top + 4)
    $label.Size = [Drawing.Size]::new(145, 24)
    $form.Controls.Add($label)
    $control.Location = [Drawing.Point]::new(165, $top)
    $control.Size = [Drawing.Size]::new(465, 27)
    $form.Controls.Add($control)
}

$form = [Windows.Forms.Form]::new()
$form.Text = "EaW Hub Deployer $version"
$form.StartPosition = 'CenterScreen'
$form.Size = [Drawing.Size]::new(670, 690)
$form.MinimumSize = [Drawing.Size]::new(670, 690)
$form.Font = [Drawing.Font]::new('Segoe UI', 9)

$title = [Windows.Forms.Label]::new()
$title.Text = 'Развёртывание серверной части EaW Hub'
$title.Font = [Drawing.Font]::new('Segoe UI Semibold', 15)
$title.Location = [Drawing.Point]::new(18, 15)
$title.AutoSize = $true
$form.Controls.Add($title)

$subtitle = [Windows.Forms.Label]::new()
$subtitle.Text = "Локальная версия: $version. Пароль и парольная фраза SSH-ключа не сохраняются."
$subtitle.Location = [Drawing.Point]::new(20, 50)
$subtitle.Size = [Drawing.Size]::new(610, 35)
$form.Controls.Add($subtitle)

$hostBox = [Windows.Forms.TextBox]::new()
$portBox = [Windows.Forms.NumericUpDown]::new()
$portBox.Minimum = 1; $portBox.Maximum = 65535; $portBox.Value = 22
$userBox = [Windows.Forms.TextBox]::new()
$rootBox = [Windows.Forms.TextBox]::new()
$passwordBox = [Windows.Forms.TextBox]::new(); $passwordBox.UseSystemPasswordChar = $true
$keyBox = [Windows.Forms.TextBox]::new()
$keyPassphraseBox = [Windows.Forms.TextBox]::new(); $keyPassphraseBox.UseSystemPasswordChar = $true
Add-Field $form 'VPS / IP:' 88 $hostBox
Add-Field $form 'SSH-порт:' 123 $portBox
Add-Field $form 'Пользователь:' 158 $userBox
Add-Field $form 'Каталог на VPS:' 193 $rootBox
Add-Field $form 'Пароль:' 228 $passwordBox
Add-Field $form 'SSH-ключ (необяз.):' 263 $keyBox
Add-Field $form 'Пароль ключа:' 298 $keyPassphraseBox

$browseButton = [Windows.Forms.Button]::new()
$browseButton.Text = '…'
$browseButton.Location = [Drawing.Point]::new(635, 263)
$browseButton.Size = [Drawing.Size]::new(27, 27)
$browseButton.Add_Click({
    $dialog = [Windows.Forms.OpenFileDialog]::new()
    $dialog.Title = 'Выберите приватный SSH-ключ'
    if ($dialog.ShowDialog() -eq 'OK') { $keyBox.Text = $dialog.FileName }
})
$form.Controls.Add($browseButton)

$fingerprintLabel = [Windows.Forms.Label]::new()
$fingerprintLabel.Location = [Drawing.Point]::new(18, 337)
$fingerprintLabel.Size = [Drawing.Size]::new(620, 42)
$fingerprintLabel.Text = 'SSH-отпечаток ещё не проверен.'
$form.Controls.Add($fingerprintLabel)

$inspectButton = [Windows.Forms.Button]::new()
$inspectButton.Text = 'Проверить VPS'
$inspectButton.Location = [Drawing.Point]::new(18, 382)
$inspectButton.Size = [Drawing.Size]::new(180, 34)
$form.Controls.Add($inspectButton)

$deployButton = [Windows.Forms.Button]::new()
$deployButton.Text = "Развернуть $version"
$deployButton.Location = [Drawing.Point]::new(208, 382)
$deployButton.Size = [Drawing.Size]::new(180, 34)
$deployButton.Enabled = $false
$form.Controls.Add($deployButton)

$statusLabel = [Windows.Forms.Label]::new()
$statusLabel.Text = 'Готово к проверке подключения.'
$statusLabel.Location = [Drawing.Point]::new(18, 426)
$statusLabel.Size = [Drawing.Size]::new(620, 24)
$form.Controls.Add($statusLabel)

$logBox = [Windows.Forms.RichTextBox]::new()
$logBox.Location = [Drawing.Point]::new(18, 454)
$logBox.Size = [Drawing.Size]::new(620, 178)
$logBox.Anchor = 'Top, Bottom, Left, Right'
$logBox.ReadOnly = $true
$logBox.BackColor = [Drawing.Color]::FromArgb(245, 245, 245)
$logBox.Font = [Drawing.Font]::new('Consolas', 9)
$form.Controls.Add($logBox)

$script:trustedFingerprint = ''
$script:running = $false

function Append-Log([string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    $logBox.AppendText($text + [Environment]::NewLine)
    $logBox.SelectionStart = $logBox.TextLength
    $logBox.ScrollToCaret()
}

function Set-Running([bool]$value) {
    $script:running = $value
    $inspectButton.Enabled = -not $value
    $deployButton.Enabled = (-not $value) -and -not [string]::IsNullOrWhiteSpace($script:trustedFingerprint)
}

function Build-Request([bool]$acceptNewHostKey) {
    [ordered]@{
        host = $hostBox.Text.Trim()
        port = [int]$portBox.Value
        username = $userBox.Text.Trim()
        remoteRoot = $rootBox.Text.Trim()
        password = $passwordBox.Text
        privateKeyPath = $keyBox.Text.Trim()
        privateKeyPassphrase = $keyPassphraseBox.Text
        hostFingerprint = $script:trustedFingerprint
        acceptNewHostKey = $acceptNewHostKey
    }
}

function Invoke-Deployer([string]$action, [bool]$acceptNewHostKey) {
    if ($script:running) { return }
    Set-Running $true
    $statusLabel.Text = if ($action -eq 'inspect') { 'Проверка VPS…' } else { 'Развёртывание…' }
    Append-Log "[$([DateTime]::Now.ToString('HH:mm:ss'))] $($statusLabel.Text)"
    try {
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $nodePath
        $start.Arguments = '"' + $deployerPath + '" ' + $action
        $start.WorkingDirectory = $projectRoot
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $start
        [void]$process.Start()
        $json = (Build-Request $acceptNewHostKey) | ConvertTo-Json -Compress
        $process.StandardInput.WriteLine($json)
        $process.StandardInput.Close()
        while (-not $process.HasExited) {
            while (-not $process.StandardOutput.EndOfStream) {
                $line = $process.StandardOutput.ReadLine()
                try {
                    $event = $line | ConvertFrom-Json
                    if ($event.event -eq 'progress') { Append-Log $event.message }
                    elseif ($event.event -eq 'remote') { Append-Log "VPS: $($event.line)" }
                    elseif ($event.event -eq 'inspection') {
                        $message = "VPS сообщает версию $($event.remoteVersion).`nSSH-отпечаток: $($event.fingerprint)`n`nДоверять этому серверу?"
                        if ([Windows.Forms.MessageBox]::Show($message, 'Проверка VPS', 'YesNo', 'Question') -eq 'Yes') {
                            $script:trustedFingerprint = $event.fingerprint
                            $fingerprintLabel.Text = "Проверен: $($event.fingerprint) | сервер: $($event.remoteVersion)"
                            Save-Configuration $script:trustedFingerprint
                            Append-Log "VPS подтверждён. Сервер: $($event.remoteVersion); локально: $($event.localVersion)."
                        }
                    } elseif ($event.event -eq 'deployed') {
                        Append-Log "Развёрнута версия $($event.version). Проверка здоровья пройдена."
                        $statusLabel.Text = "Сервер обновлён до $($event.version)."
                    } elseif ($event.event -eq 'error') { Append-Log "ОШИБКА: $($event.message)" }
                } catch { Append-Log $line }
                [Windows.Forms.Application]::DoEvents()
            }
            Start-Sleep -Milliseconds 50
            [Windows.Forms.Application]::DoEvents()
        }
        while (-not $process.StandardOutput.EndOfStream) { Append-Log $process.StandardOutput.ReadLine() }
        $stderr = $process.StandardError.ReadToEnd()
        if ($stderr) { Append-Log $stderr.Trim() }
        if ($process.ExitCode -ne 0) {
            $statusLabel.Text = 'Операция завершилась с ошибкой.'
        } elseif ($action -eq 'inspect') {
            $statusLabel.Text = 'Проверка VPS завершена.'
        }
    } catch {
        Append-Log "ОШИБКА: $($_.Exception.Message)"
        $statusLabel.Text = 'Операция завершилась с ошибкой.'
    } finally {
        Set-Running $false
    }
}

$inspectButton.Add_Click({ Invoke-Deployer 'inspect' $true })
$deployButton.Add_Click({
    $answer = [Windows.Forms.MessageBox]::Show(
        "Обновить сервер до $version?`n`nDeployer создаст резервную копию кода, проверит SHA-256 и откатится при неудачной проверке /health.",
        'Подтверждение развёртывания', 'YesNo', 'Warning')
    if ($answer -eq 'Yes') { Invoke-Deployer 'deploy' $false }
})

$configuration = Load-Configuration
$hostBox.Text = if ($configuration.Host) { $configuration.Host } else { '' }
$userBox.Text = if ($configuration.Username) { $configuration.Username } else { 'root' }
$rootBox.Text = if ($configuration.RemoteRoot) { $configuration.RemoteRoot } else { '/opt/eaw-localisation-hub' }
if ($configuration.Port) { $portBox.Value = [int]$configuration.Port }
if ($configuration.PrivateKeyPath) { $keyBox.Text = $configuration.PrivateKeyPath }
if ($configuration.HostFingerprint) {
    $script:trustedFingerprint = $configuration.HostFingerprint
    $fingerprintLabel.Text = "Сохранённый отпечаток: $($configuration.HostFingerprint). Нажмите «Проверить VPS»."
    $deployButton.Enabled = $true
}

[void]$form.ShowDialog()
