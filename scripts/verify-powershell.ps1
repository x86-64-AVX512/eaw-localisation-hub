$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scripts = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1'
$failures = [System.Collections.Generic.List[string]]::new()

foreach ($script in $scripts) {
    $bytes = [System.IO.File]::ReadAllBytes($script.FullName)
    $hasUtf8Bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and
        $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if (-not $hasUtf8Bom -and @($bytes | Where-Object { $_ -gt 0x7F }).Count -gt 0) {
        $failures.Add("$($script.Name): non-ASCII PowerShell source needs a UTF-8 BOM for Windows PowerShell 5.1.")
    }
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
