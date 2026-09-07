function Show-EawAuditDialog {
    param([System.Windows.Forms.Form]$Owner)
    $dialog = [System.Windows.Forms.Form]::new()
    $dialog.Text = 'EaW Hub Admin – Журнал действий'
    $dialog.Size = [System.Drawing.Size]::new(1080, 700)
    $dialog.MinimumSize = [System.Drawing.Size]::new(1080, 700)
    $dialog.StartPosition = 'CenterParent'
    $actorLabel = [System.Windows.Forms.Label]::new()
    $actorLabel.Text = 'Имя или ID:'; $actorLabel.Location = [System.Drawing.Point]::new(15, 18)
    $actorLabel.Size = [System.Drawing.Size]::new(85, 22); $dialog.Controls.Add($actorLabel)
    $actorFilter = [System.Windows.Forms.TextBox]::new()
    $actorFilter.Location = [System.Drawing.Point]::new(105, 15); $actorFilter.Width = 200
    $dialog.Controls.Add($actorFilter)
    $actionFilter = [System.Windows.Forms.ComboBox]::new()
    $actionFilter.DropDownStyle = 'DropDownList'
    $actionFilter.Location = [System.Drawing.Point]::new(320, 15); $actionFilter.Width = 180
    $categories = @('Все действия', 'Тикеты', 'Комментарии', 'Правки', 'Брони', 'Редактирование текста', 'Управление аккаунтами', 'Git', 'История')
    $prefixes = @('', 'ticket-', 'comment-', 'suggestion-', 'reservation-', 'document-edit', 'account-', 'git-', 'history-')
    $actionFilter.Items.AddRange([object[]]$categories); $actionFilter.SelectedIndex = 0
    $dialog.Controls.Add($actionFilter)
    $from = [System.Windows.Forms.DateTimePicker]::new()
    $from.Location = [System.Drawing.Point]::new(515, 15); $from.Width = 160
    $from.Format = 'Custom'; $from.CustomFormat = 'dd.MM.yyyy HH:mm'; $from.ShowCheckBox = $true; $from.Checked = $false
    $dialog.Controls.Add($from)
    $to = [System.Windows.Forms.DateTimePicker]::new()
    $to.Location = [System.Drawing.Point]::new(690, 15); $to.Width = 160
    $to.Format = 'Custom'; $to.CustomFormat = 'dd.MM.yyyy HH:mm'; $to.ShowCheckBox = $true; $to.Checked = $false
    $dialog.Controls.Add($to)
    $refresh = [System.Windows.Forms.Button]::new()
    $refresh.Text = 'Показать'; $refresh.Location = [System.Drawing.Point]::new(870, 12); $refresh.Size = [System.Drawing.Size]::new(170, 28)
    $dialog.Controls.Add($refresh)
    $hint = [System.Windows.Forms.Label]::new()
    $hint.Text = 'Даты: с / по (местное время). Новые события сверху. «Начато» без результата может означать прерывание операции.'
    $hint.Location = [System.Drawing.Point]::new(15, 50); $hint.Size = [System.Drawing.Size]::new(1020, 25)
    $dialog.Controls.Add($hint)
    $list = [System.Windows.Forms.ListView]::new()
    $list.Location = [System.Drawing.Point]::new(15, 80); $list.Size = [System.Drawing.Size]::new(1025, 340)
    $list.Anchor = 'Top, Bottom, Left, Right'; $list.View = 'Details'; $list.FullRowSelect = $true; $list.MultiSelect = $false
    foreach ($column in @(@('Время', 145), @('Пользователь', 150), @('Действие', 220), @('Результат', 100), @('Объект', 385))) {
        [void]$list.Columns.Add([string]$column[0], [int]$column[1])
    }
    $dialog.Controls.Add($list)
    $details = [System.Windows.Forms.TextBox]::new()
    $details.Location = [System.Drawing.Point]::new(15, 435); $details.Size = [System.Drawing.Size]::new(1025, 155)
    $details.Anchor = 'Bottom, Left, Right'; $details.Multiline = $true; $details.ReadOnly = $true; $details.ScrollBars = 'Vertical'
    $dialog.Controls.Add($details)
    $older = [System.Windows.Forms.Button]::new()
    $older.Text = 'Более ранние'; $older.Location = [System.Drawing.Point]::new(15, 610); $older.Size = [System.Drawing.Size]::new(145, 30)
    $older.Anchor = 'Bottom, Left'; $dialog.Controls.Add($older)
    $statusText = [System.Windows.Forms.Label]::new()
    $statusText.Location = [System.Drawing.Point]::new(180, 616); $statusText.Size = [System.Drawing.Size]::new(680, 25)
    $statusText.Anchor = 'Bottom, Left'; $dialog.Controls.Add($statusText)
    $close = [System.Windows.Forms.Button]::new()
    $close.Text = 'Закрыть'; $close.Location = [System.Drawing.Point]::new(895, 610); $close.Size = [System.Drawing.Size]::new(145, 30)
    $close.Anchor = 'Bottom, Right'; $close.DialogResult = 'Cancel'; $dialog.Controls.Add($close); $dialog.CancelButton = $close
    $pages = @{ Cursor = ''; Query = '' }
    $labels = @{
        'ticket-create' = 'Создание тикета'; 'ticket-update' = 'Изменение тикета'; 'ticket-delete' = 'Удаление тикета'
        'ticket-archive' = 'Архивирование тикета'; 'ticket-apply' = 'Применение тикета'; 'ticket-rebase' = 'Обновление базы тикета'
        'ticket-files' = 'Смена файлов тикета'; 'ticket-conflict' = 'Конфликт тикета'
        'comment-create' = 'Создание комментария'; 'comment-reply' = 'Ответ на комментарий'; 'comment-status' = 'Статус комментария'; 'comment-delete' = 'Удаление комментария'
        'suggestion-create' = 'Создание правки'; 'suggestion-update' = 'Изменение правки'; 'suggestion-reply' = 'Ответ на правку'
        'suggestion-accept' = 'Принятие правки'; 'suggestion-revert' = 'Отмена принятия'; 'suggestion-reject' = 'Отклонение правки'; 'suggestion-delete' = 'Удаление правки'
        'reservation-create' = 'Создание брони'; 'reservation-delete' = 'Удаление брони'; 'document-edit' = 'Редактирование текста'
        'git-conflict-resolve' = 'Разрешение конфликта Git'; 'personal-projection-resolve' = 'Разрешение личного конфликта'; 'history-restore' = 'Применение версии из истории'
        'account-invite-create' = 'Создание приглашения'; 'account-invite-delete' = 'Удаление приглашения'; 'account-invite-revoke' = 'Отзыв приглашения'
        'account-enable' = 'Включение аккаунта'; 'account-disable' = 'Отключение аккаунта'; 'account-delete' = 'Удаление аккаунта'
        'account-roles' = 'Изменение ролей'; 'account-session-revoke' = 'Отзыв сессии'; 'account-recovery-authorize' = 'Разрешение нового кода'; 'account-temporary-password' = 'Выдача временного пароля'
    }
    $outcomes = @{ completed = 'Выполнено'; started = 'Начато'; failed = 'Ошибка' }
    $load = {
        param([bool]$Reset)
        try {
            $refresh.Enabled = $false; $older.Enabled = $false
            if ($Reset) {
                $pages.Cursor = ''
                $pages.Query = 'limit=100&actor=' + [Uri]::EscapeDataString($actorFilter.Text.Trim()) + '&action=' + [Uri]::EscapeDataString($prefixes[$actionFilter.SelectedIndex])
                if ($from.Checked) { $pages.Query += '&from=' + [Uri]::EscapeDataString($from.Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) }
                if ($to.Checked) { $pages.Query += '&to=' + [Uri]::EscapeDataString($to.Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) }
            }
            $payload = Invoke-HubAdminApi -Method Get -Route ('/api/admin/audit?' + $pages.Query + '&before=' + [Uri]::EscapeDataString($pages.Cursor))
            $list.Items.Clear(); $details.Clear()
            foreach ($record in @($payload.records)) {
                $item = [System.Windows.Forms.ListViewItem]::new([DateTimeOffset]::Parse($record.at).ToLocalTime().ToString('dd.MM.yyyy HH:mm:ss'))
                [void]$item.SubItems.Add([string]$record.actor)
                $label = if ($labels.ContainsKey([string]$record.action)) { $labels[[string]$record.action] } else { [string]$record.action }
                [void]$item.SubItems.Add($label); [void]$item.SubItems.Add([string]$outcomes[[string]$record.outcome])
                $target = if ($record.details.title) { [string]$record.details.title } else { [string]$record.target }
                [void]$item.SubItems.Add($target); $item.Tag = $record; [void]$list.Items.Add($item)
            }
            $pages.Cursor = [string]$payload.nextCursor
            $statusText.Text = "Записей на странице: $($list.Items.Count)."
        } catch { $statusText.Text = "Ошибка: $($_.Exception.Message)" }
        finally { $refresh.Enabled = $true; $older.Enabled = -not [string]::IsNullOrEmpty($pages.Cursor) }
    }
    $list.Add_SelectedIndexChanged({
        if ($list.SelectedItems.Count -ne 1) { return }
        $record = $list.SelectedItems[0].Tag
        $details.Text = "ID пользователя: $($record.actorId)`r`nОбъект: $($record.target)`r`nID операции: $($record.operationId)`r`n" + ($record.details | ConvertTo-Json -Depth 6)
    })
    $refresh.Add_Click({ & $load $true }); $older.Add_Click({ & $load $false })
    $dialog.Add_Shown({ & $load $true })
    try { [void]$dialog.ShowDialog($Owner) } finally { $dialog.Dispose() }
}
