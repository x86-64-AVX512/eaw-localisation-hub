
. (Join-Path $PSScriptRoot 'ui-language.ps1')
$script:clientUpdateWindow = $null

function Initialize-ClientUpdateWindow {
    param([string]$Version)
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $window = [System.Windows.Forms.Form]::new()
    $window.Text = (Get-EawUiText -Text 'EaW Hub – обновление до {0}' -Values @($Version))
    $window.ClientSize = [System.Drawing.Size]::new(540, 245)
    $window.StartPosition = 'CenterScreen'
    $window.FormBorderStyle = 'FixedDialog'
    $window.MaximizeBox = $false
    $window.TopMost = $true
    $window.AutoScaleMode = 'Dpi'
    $window.Font = [System.Drawing.Font]::new('Segoe UI', 10)
    $heading = [System.Windows.Forms.Label]::new()
    $heading.Text = (Get-EawUiText -Text 'Обновление EaW Localisation Hub до {0}' -Values @($Version))
    $heading.Font = [System.Drawing.Font]::new('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
    $heading.SetBounds(20, 18, 500, 32)
    $message = [System.Windows.Forms.TextBox]::new()
    $message.Multiline = $true
    $message.ReadOnly = $true
    $message.BorderStyle = 'None'
    $message.BackColor = [System.Drawing.SystemColors]::Control
    $message.ScrollBars = 'Vertical'
    $message.SetBounds(20, 58, 500, 56)
    $progress = [System.Windows.Forms.ProgressBar]::new()
    $progress.SetBounds(20, 122, 500, 24)
    $progress.Style = 'Marquee'
    $progress.MarqueeAnimationSpeed = 25
    $detail = [System.Windows.Forms.Label]::new()
    $detail.SetBounds(20, 152, 500, 25)
    $footer = [System.Windows.Forms.Label]::new()
    $footer.Text = (Get-EawUiText -Text 'Agent автоматически перезапустится после установки.')
    $footer.SetBounds(20, 193, 405, 40)
    $close = [System.Windows.Forms.Button]::new()
    $close.Text = (Get-EawUiText -Text 'Закрыть')
    $close.SetBounds(430, 191, 90, 32)
    $close.Visible = $false
    $close.Add_Click({ $script:clientUpdateWindow.Form.Close() })
    $window.Controls.AddRange(@($heading, $message, $progress, $detail, $footer, $close))
    $script:clientUpdateWindow = [pscustomobject]@{
        Form = $window; Message = $message; Progress = $progress; Detail = $detail
        Footer = $footer; Close = $close; Terminal = $false; Failed = $false
    }
    $window.Add_FormClosing({
        param($sender, $eventArgs)
        if (-not $script:clientUpdateWindow.Terminal) { $eventArgs.Cancel = $true }
    })
}

function Show-ClientUpdateWindow {
    param([string]$Version)
    Initialize-ClientUpdateWindow -Version $Version
    $script:clientUpdateWindow.Form.Show()
    $script:clientUpdateWindow.Form.Activate()
    Invoke-ClientUpdateUiPulse
}

function Invoke-ClientUpdateUiPulse {
    if ($null -ne $script:clientUpdateWindow -and -not $script:clientUpdateWindow.Form.IsDisposed) {
        [System.Windows.Forms.Application]::DoEvents()
    }
}

function Set-ClientUpdateWindowStatus {
    param($Status)
    $view = $script:clientUpdateWindow
    if ($null -eq $view -or $view.Form.IsDisposed) { return }
    $view.Message.Text = [string]$Status.Message
    if ($null -ne $Status.ProgressPercent) {
        $view.Progress.Style = 'Continuous'
        $view.Progress.Value = [Math]::Max(0, [Math]::Min(100, [int]$Status.ProgressPercent))
    } else {
        $view.Progress.Style = 'Marquee'
    }
    $view.Detail.Text = if ($Status.BytesTotal -gt 0) {
        (Get-EawUiText -Text '{0:N1} / {1:N1} МБ – {2}%') -f ($Status.BytesReceived / 1MB), ($Status.BytesTotal / 1MB), $Status.ProgressPercent
    } elseif ($Status.Stage -eq 'installing') {
        (Get-EawUiText -Text 'Ожидание установщика и подтверждения Windows (UAC)…')
    } elseif ($Status.Stage -eq 'restarting') {
        (Get-EawUiText -Text 'Проверка запуска нового Agent…')
    } else { '' }
    if ($Status.Stage -in @('complete', 'error')) {
        $view.Terminal = $true
        $view.Failed = $Status.Stage -eq 'error'
        $view.Close.Visible = $true
        $view.Progress.Style = 'Continuous'
        $view.Progress.Value = if ($view.Failed) { 0 } else { 100 }
        $view.Message.ForeColor = if ($view.Failed) { [System.Drawing.Color]::Firebrick } else { [System.Drawing.Color]::ForestGreen }
        $view.Footer.Text = if ($view.Failed) { (Get-EawUiText -Text 'Клиент не обновлён полностью. Проверьте сообщение выше.') } else { (Get-EawUiText -Text 'Можно продолжать работу.') }
        $view.Form.WindowState = 'Normal'
        $view.Form.Activate()
    }
    Invoke-ClientUpdateUiPulse
}

function Close-ClientUpdateWindow {
    $view = $script:clientUpdateWindow
    if ($null -eq $view) { return }
    if ($view.Failed) {
        # Keep a failure readable until dismissed; the updater mutex is already released.
        while (-not $view.Form.IsDisposed -and $view.Form.Visible) {
            Invoke-ClientUpdateUiPulse
            Start-Sleep -Milliseconds 50
        }
    } elseif ($view.Terminal) {
        $until = [DateTime]::UtcNow.AddSeconds(3)
        while (-not $view.Form.IsDisposed -and [DateTime]::UtcNow -lt $until) {
            Invoke-ClientUpdateUiPulse
            Start-Sleep -Milliseconds 50
        }
    }
    $view.Terminal = $true
    $view.Form.Dispose()
    $script:clientUpdateWindow = $null
}
