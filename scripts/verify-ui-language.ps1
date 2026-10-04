param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ui-language.ps1')
if ((Get-EawUiText -Text 'Закрыть' -Language en) -cne 'Close') { throw 'English label failed' }
if ((Get-EawUiText -Text 'Закрыть' -Language ru) -cne 'Закрыть') { throw 'Russian label failed' }
$opaque = 'Пользователь {0} <b> C:\Тест\файл.yml'
if ((Get-EawUiText -Text 'Роли: {0}' -Values @($opaque) -Language en) -cne ('Roles: ' + $opaque)) { throw 'Opaque parameter failed' }
if ((Get-EawUiMessage -Text ('Роли: ' + $opaque) -Language en) -cne ('Roles: ' + $opaque)) { throw 'Legacy diagnostic failed' }
$literal = 'user ' + [char]0x2014 + ' ' + [char]0x201c + 'unchanged' + [char]0x201d + ' {0}'
foreach ($language in @('ru', 'en')) {
    $prefix = if ($language -eq 'en') { 'ticket' } else { 'тикет' }
    $expectedTicket = $prefix + ' «' + $literal + '»'
    if ((Get-EawUiText -Text 'тикет «{0}»' -Values @($literal) -Language $language) -cne $expectedTicket) { throw 'Quoted parameter changed' }
    if ((Get-EawUiMessage -Text ('тикет «' + $literal + '»') -Language $language) -cne $expectedTicket) { throw 'Quoted diagnostic parameter changed' }
    $expectedTitle = if ($language -eq 'en') { 'EaW Hub – update to 0.8.8F8' } else { 'EaW Hub – обновление до 0.8.8F8' }
    if ((Get-EawUiText -Text 'EaW Hub – обновление до {0}' -Values @('0.8.8F8') -Language $language) -cne $expectedTitle) { throw 'Updater title translation failed' }
    $expectedExample = if ($language -eq 'en') { 'key:0 "text"' } else { 'key:0 "текст"' }
    if ((Get-EawUiText -Text 'key:0 "текст"' -Language $language) -cne $expectedExample) { throw 'YAML example quotes changed' }
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('eaw-ui-language-' + [Guid]::NewGuid().ToString('N'))
try {
    Set-EawUiLanguage -Preference en -StateDirectory $temporary
    if ((Get-EawUiLanguageSettings -StateDirectory $temporary).language -ne 'en') { throw 'Saved English preference failed' }
    Set-EawUiLanguage -Preference ru -StateDirectory $temporary
    if ((Get-EawUiLanguageSettings -StateDirectory $temporary).language -ne 'ru') { throw 'Saved Russian preference failed' }
    Set-EawUiLanguage -Preference auto -StateDirectory $temporary
    $expected = if ([Globalization.CultureInfo]::CurrentUICulture.Name -match '^ru(-|$)') { 'ru' } else { 'en' }
    if ((Get-EawUiLanguageSettings -StateDirectory $temporary).language -ne $expected) { throw 'Windows UI culture failed' }
} finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
Write-Output '[ui-language] RU/EN, Windows UI culture, saved preference and opaque parameters passed'
