$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scripts = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1'
$failures = [System.Collections.Generic.List[string]]::new()

foreach ($script in $scripts) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $script.FullName,
        [ref]$tokens,
        [ref]$parseErrors) | Out-Null
    foreach ($parseError in @($parseErrors)) {
        $failures.Add("$($script.Name):$($parseError.Extent.StartLineNumber): $($parseError.Message)")
    }
}

$launcher = Join-Path $projectRoot 'Launch EaW Hub Prototype.cmd'
if (-not (Test-Path -LiteralPath $launcher)) {
    $failures.Add('The one-click launcher is missing.')
}

if ($failures.Count -gt 0) {
    throw ($failures -join [Environment]::NewLine)
}
Write-Output "[powershell-smoke] parsed $($scripts.Count) script(s)"
