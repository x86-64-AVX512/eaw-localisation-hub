# Shared file contract with apps/agent/src/repository-sync.mjs. No Git runs on the UI thread.
function Get-EawRepositorySyncDirectory {
    param([string]$StateDirectory, [string]$Repository)
    if ([string]::IsNullOrWhiteSpace($Repository)) { throw 'Выберите репозиторий EaW.' }
    $identity = [IO.Path]::GetFullPath($Repository).TrimEnd([char[]]'\/').ToLowerInvariant()
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $digest = -join ($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $hasher.Dispose() }
    Join-Path (Join-Path $StateDirectory 'repository-sync') $digest
}

function Read-EawRepositorySyncJson {
    param([string]$Path)
    try { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null }
}

function Write-EawRepositorySyncJson {
    param([string]$Path, $Value)
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Get-EawRepositorySyncSettings {
    param([string]$Directory)
    $value = Read-EawRepositorySyncJson (Join-Path $Directory 'settings.json')
    [pscustomobject]@{
        autoFetch = $value.autoFetch -eq $true
        autoPull = $value.autoPull -eq $true
        intervalMinutes = $(if ($value.intervalMinutes -in @(1, 5, 10, 15, 30)) { [int]$value.intervalMinutes } else { 5 })
        sound = $value.sound -ne $false
        flash = $value.flash -ne $false
        notification = $value.notification -ne $false
    }
}

function Request-EawRepositorySync {
    param([string]$Directory, [int]$AgentProcessId, [ValidateSet('check', 'update')][string]$Action)
    Write-EawRepositorySyncJson (Join-Path $Directory 'request.json') ([pscustomobject]@{
        schema = 1; id = [Guid]::NewGuid().ToString('N'); pid = $AgentProcessId; action = $Action
    })
}

function Show-EawRepositorySyncSettings {
    param($Owner, [string]$Directory)
    $settings = Get-EawRepositorySyncSettings $Directory
    $dialog = [Windows.Forms.Form]::new()
    $dialog.Text = 'Git — настройки для выбранного репозитория'
    $dialog.ClientSize = [Drawing.Size]::new(570, 385)
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false; $dialog.MinimizeBox = $false
    $dialog.StartPosition = 'CenterParent'
    $checks = @{}
    $rows = @(
        @('autoFetch', 'Автоматически проверять новые коммиты (git fetch)'),
        @('autoPull', 'Автоматически обновлять текущую ветку (только fast-forward)'),
        @('sound', 'Звуковой сигнал при блокировке обновления'),
        @('flash', 'Мигание кнопки Agent на панели задач'),
        @('notification', 'Уведомление Windows о блокировке обновления')
    )
    for ($index = 0; $index -lt $rows.Count; $index++) {
        $check = [Windows.Forms.CheckBox]::new()
        $check.Text = $rows[$index][1]
        $check.Checked = [bool]$settings.($rows[$index][0])
        $check.Location = [Drawing.Point]::new(18, (18 + $index * 31))
        $check.Size = [Drawing.Size]::new(530, 26)
        $dialog.Controls.Add($check)
        $checks[$rows[$index][0]] = $check
    }
    $label = [Windows.Forms.Label]::new()
    $label.Text = 'Интервал проверки, минут:'
    $label.Location = [Drawing.Point]::new(18, 183); $label.Size = [Drawing.Size]::new(220, 25)
    $dialog.Controls.Add($label)
    $interval = [Windows.Forms.ComboBox]::new()
    $interval.DropDownStyle = 'DropDownList'
    $interval.Items.AddRange([object[]]@(1, 5, 10, 15, 30))
    $interval.SelectedItem = [int]$settings.intervalMinutes
    $interval.Location = [Drawing.Point]::new(240, 180); $interval.Size = [Drawing.Size]::new(75, 25)
    $dialog.Controls.Add($interval)
    $notice = [Windows.Forms.Label]::new()
    $notice.Text = 'Автообновление включает проверку новых коммитов. Нужен настроенный upstream. При локальных изменениях, конфликтах или неподтверждённых правках Review ветка не меняется. Никаких reset, stash, rebase, коммитов и push. Сигнал — один раз, пока проблема не решена.'
    $notice.Location = [Drawing.Point]::new(18, 221); $notice.Size = [Drawing.Size]::new(530, 91)
    $dialog.Controls.Add($notice)
    $save = [Windows.Forms.Button]::new()
    $save.Text = 'Сохранить'; $save.Location = [Drawing.Point]::new(330, 331); $save.Size = [Drawing.Size]::new(105, 32)
    $dialog.Controls.Add($save)
    $cancel = [Windows.Forms.Button]::new()
    $cancel.Text = 'Отмена'; $cancel.Location = [Drawing.Point]::new(443, 331); $cancel.Size = [Drawing.Size]::new(105, 32)
    $cancel.DialogResult = 'Cancel'; $dialog.Controls.Add($cancel)
    $dialog.CancelButton = $cancel
    $save.Add_Click({
        try {
            $value = [ordered]@{ intervalMinutes = [int]$interval.SelectedItem }
            foreach ($name in $checks.Keys) { $value[$name] = $checks[$name].Checked }
            Write-EawRepositorySyncJson (Join-Path $Directory 'settings.json') $value
            $dialog.DialogResult = 'OK'; $dialog.Close()
        } catch { [void][Windows.Forms.MessageBox]::Show($dialog, $_.Exception.Message, 'Настройки не сохранены', 'OK', 'Warning') }
    })
    try { [void]$dialog.ShowDialog($Owner) } finally { $dialog.Dispose() }
}

function Test-EawRepositorySyncStatus {
    param($Value, [int]$AgentProcessId, [string]$Repository)
    if (-not $Value -or [int]$Value.schema -ne 1 -or [int]$Value.pid -ne $AgentProcessId) { return $false }
    try {
        if ([IO.Path]::GetFullPath([string]$Value.repository).TrimEnd([char[]]'\/') -ine
            [IO.Path]::GetFullPath($Repository).TrimEnd([char[]]'\/')) { return $false }
        $age = ([DateTime]::UtcNow - [DateTime]::Parse([string]$Value.updatedAt).ToUniversalTime()).TotalSeconds
        return $age -ge -5 -and $age -lt 90
    } catch { return $false }
}

function Get-EawRepositorySyncTiming {
    param($Value, [DateTime]$NowUtc = [DateTime]::UtcNow)
    $last = 'ещё не было'
    if ($Value.checkedAt) {
        try { $last = [DateTime]::Parse([string]$Value.checkedAt).ToLocalTime().ToString('dd.MM HH:mm:ss') } catch {}
    }
    $next = 'Расписание пока недоступно.'
    if ($Value.stage -in @('checking', 'fetching')) { $next = 'Проверка выполняется…' }
    elseif ($Value.stage -eq 'updating') { $next = 'Обновление выполняется…' }
    elseif ($Value.settings -and -not ($Value.settings.autoFetch -or $Value.settings.autoPull)) { $next = 'Автопроверка выключена.' }
    elseif ($Value.nextCheckAt) {
        try {
            $seconds = [Math]::Max(0, [Math]::Ceiling(([DateTime]::Parse([string]$Value.nextCheckAt).ToUniversalTime() - $NowUtc.ToUniversalTime()).TotalSeconds))
            $next = if ($seconds -gt 0) { 'Следующая через {0:00}:{1:00}' -f [Math]::Floor($seconds / 60), ($seconds % 60) } else { 'Следующая: скоро…' }
        } catch {}
    }
    "Последняя проверка: $last | $next"
}

function Show-EawRepositorySyncAlert {
    param($Owner, $Tray, $Settings, [string]$Message)
    # Finite taskbar flashing: never Activate/BringToFront and no endless blinking.
    if ($Settings.flash) {
        if (-not ('EawRepositorySyncFlash' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EawRepositorySyncFlash {
    [StructLayout(LayoutKind.Sequential)] public struct Info {
        public uint cbSize; public IntPtr hwnd; public uint flags; public uint count; public uint timeout;
    }
    [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref Info info);
    public static void Flash(IntPtr hwnd) {
        var info = new Info { cbSize = (uint)Marshal.SizeOf(typeof(Info)), hwnd = hwnd, flags = 2, count = 3, timeout = 700 };
        FlashWindowEx(ref info);
    }
}
'@
        }
        if ($Owner.Visible) { [EawRepositorySyncFlash]::Flash($Owner.Handle) }
    }
    if ($Settings.sound) { [Media.SystemSounds]::Exclamation.Play() }
    if ($Settings.notification) { $Tray.ShowBalloonTip(6000, 'EaW Hub — ветка не обновлена', $Message, 'Warning') }
}
