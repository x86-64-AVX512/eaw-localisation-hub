param([string]$Root,[string]$Scratch)
# Runs Confirm-ReviewLaunch from start-agent-ui.ps1 against real failing and succeeding launcher processes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Root 'scripts\start-agent-ui.ps1'), [ref]$tokens, [ref]$errors)
$definition = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Confirm-ReviewLaunch' }, $true) | Select-Object -First 1
Invoke-Expression $definition.Extent.Text
function Get-EawUiText { param([string]$Text, [object[]]$Values) if ($Values) { $Text -f $Values } else { $Text } }
function Get-EawUiMessage { param([string]$Text) $Text }
$status = @{ Text = '' }
$reviewLaunchTimer = [System.Windows.Forms.Timer]::new()
$scratch = $Scratch
$failing = Join-Path $scratch 'failing-hub.ps1'
Set-Content -LiteralPath $failing -Value "throw 'Desktop Agent did not start in time. Open Agent to inspect its setup error.'" -Encoding utf8
foreach ($case in @(@{ Script = $failing }, @{ Script = $null })) {
    $errorLog = Join-Path $scratch 'review-launch.err.log'
    $arguments = if ($case.Script) { '-NoProfile -ExecutionPolicy Bypass -File "' + $case.Script + '"' } else { '-NoProfile -Command exit 0' }
    $process = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError $errorLog -PassThru
    [void]$process.Handle
    $script:reviewLaunch = @{ Process = $process; ErrorLog = $errorLog }
    [void]$process.WaitForExit(20000)
    Confirm-ReviewLaunch
    [pscustomobject]@{ exit = $process.ExitCode; status = $status.Text; pending = $null -ne $script:reviewLaunch } | ConvertTo-Json -Compress
}
