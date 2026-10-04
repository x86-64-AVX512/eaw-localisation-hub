# UI language follows Windows UI culture, never region or keyboard layout.
$script:EawUiCatalog = $null
$script:EawUiCatalogPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'packages\shared\locales\en.json'
$script:EawUiSettingsCache = $null
$script:EawUiSettingsCheckedAt = [DateTime]::MinValue

function Get-EawUiLanguageSettings {
    param([string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'EaWLocalisationHub'))
    if ($script:EawUiSettingsCache -and $script:EawUiSettingsCache.Directory -eq $StateDirectory -and
        ([DateTime]::UtcNow - $script:EawUiSettingsCheckedAt).TotalSeconds -lt 1) { return $script:EawUiSettingsCache.Value }
    $preference = 'auto'
    try {
        $saved = Get-Content -LiteralPath (Join-Path $StateDirectory 'ui-language.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($saved.preference -in @('auto', 'ru', 'en')) { $preference = [string]$saved.preference }
    } catch {}
    $culture = [Globalization.CultureInfo]::CurrentUICulture.Name
    $language = if ($preference -eq 'ru' -or ($preference -eq 'auto' -and $culture -match '^ru(-|$)')) { 'ru' } else { 'en' }
    $result = [pscustomobject]@{ preference = $preference; language = $language; windowsUiCulture = $culture }
    $script:EawUiSettingsCache = @{ Directory = $StateDirectory; Value = $result }
    $script:EawUiSettingsCheckedAt = [DateTime]::UtcNow
    $result
}

function Set-EawUiLanguage {
    param([ValidateSet('auto', 'ru', 'en')][string]$Preference,
        [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'EaWLocalisationHub'))
    [void][IO.Directory]::CreateDirectory($StateDirectory)
    $record = @{ preference = $Preference; windowsUiCulture = [Globalization.CultureInfo]::CurrentUICulture.Name }
    $target = Join-Path $StateDirectory 'ui-language.json'
    $temporary = $target + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($target)) { [IO.File]::Replace($temporary, $target, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $target) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    $script:EawUiSettingsCache = $null
}

function Get-EawUiText {
    param([AllowEmptyString()][string]$Text, [AllowEmptyCollection()][object[]]$Values = @(),
        [ValidateSet('auto', 'ru', 'en')][string]$Language = 'auto')
    $result = $Text
    if ($Language -eq 'en' -or ($Language -eq 'auto' -and (Get-EawUiLanguageSettings).language -eq 'en')) {
        if ($null -eq $script:EawUiCatalog) {
            Add-Type -AssemblyName System.Web.Extensions
            # JavaScriptSerializer preserves case-sensitive JSON keys on PS 5.1.
            $parser = [Web.Script.Serialization.JavaScriptSerializer]::new()
            $script:EawUiCatalog = $parser.DeserializeObject([IO.File]::ReadAllText($script:EawUiCatalogPath, [Text.Encoding]::UTF8))
        }
        if ($script:EawUiCatalog.ContainsKey($Text)) { $result = $script:EawUiCatalog[$Text] }
    }
    # Replace parameters in one pass: values may themselves contain {0}, quotes,
    # Cyrillic, paths or passwords and must never be interpreted as UI messages.
    $parameters = $Values
    [regex]::Replace($result, '\{(\d+)\}', [Text.RegularExpressions.MatchEvaluator]{
        param($match)
        $index = [int]$match.Groups[1].Value
        if ($index -lt $parameters.Count) { [string]$parameters[$index] } else { $match.Value }
    }.GetNewClosure())
}

function Get-EawUiMessage {
    param([AllowEmptyString()][string]$Text, [ValidateSet('auto', 'ru', 'en')][string]$Language = 'auto')
    if ($Language -eq 'ru' -or ($Language -eq 'auto' -and (Get-EawUiLanguageSettings).language -eq 'ru')) { return $Text }
    [void](Get-EawUiText -Text '' -Language en)
    if ($script:EawUiCatalog.ContainsKey($Text)) { return $script:EawUiCatalog[$Text] }
    if ($null -eq $script:EawUiPatterns) {
        $script:EawUiPatterns = @($script:EawUiCatalog.Keys | Where-Object { $_ -match '\{\d+\}' } |
            Sort-Object { ([regex]::Replace($_, '\{\d+\}', '')).Length } -Descending | ForEach-Object {
                $source = $_
                $pattern = [regex]::Replace([regex]::Escape($source), '\\\{(\d+)\\?}', [Text.RegularExpressions.MatchEvaluator]{
                    param($match) '(?<p' + $match.Groups[1].Value + '>[\s\S]*?)'
                })
                @{ Pattern = [regex]::new('^' + $pattern + '$'); Translation = $script:EawUiCatalog[$source] }
            })
    }
    foreach ($entry in $script:EawUiPatterns) {
        $matched = $entry.Pattern.Match($Text)
        if ($matched.Success) {
            return [regex]::Replace($entry.Translation, '\{(\d+)\}', [Text.RegularExpressions.MatchEvaluator]{
                param($match) $matched.Groups['p' + $match.Groups[1].Value].Value
            }.GetNewClosure())
        }
    }
    return $Text
}

function Show-EawUiLanguageSettings {
    param($Owner)
    $dialog = [Windows.Forms.Form]::new()
    $dialog.Text = 'Language / Язык'
    $dialog.ClientSize = [Drawing.Size]::new(410, 170)
    $dialog.StartPosition = 'CenterParent'; $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false; $dialog.MinimizeBox = $false
    $select = [Windows.Forms.ComboBox]::new(); $select.DropDownStyle = 'DropDownList'
    $select.Items.AddRange([object[]]@('Windows (automatic)', 'Русский', 'English'))
    $select.SelectedIndex = [array]::IndexOf(@('auto', 'ru', 'en'), (Get-EawUiLanguageSettings).preference)
    $select.Location = [Drawing.Point]::new(20, 20); $select.Size = [Drawing.Size]::new(370, 26)
    $dialog.Controls.Add($select)
    $hint = [Windows.Forms.Label]::new(); $hint.Text = 'Reopen windows to apply. / Откройте окна заново.'
    $hint.Location = [Drawing.Point]::new(20, 61); $hint.Size = [Drawing.Size]::new(370, 40)
    $dialog.Controls.Add($hint)
    $save = [Windows.Forms.Button]::new(); $save.Text = 'Apply / Применить'
    $save.Location = [Drawing.Point]::new(250, 116); $save.Size = [Drawing.Size]::new(140, 32)
    $dialog.Controls.Add($save)
    $save.Add_Click({ Set-EawUiLanguage -Preference (@('auto', 'ru', 'en')[$select.SelectedIndex]); $dialog.Close() })
    try { [void]$dialog.ShowDialog($Owner) } finally { $dialog.Dispose() }
}
