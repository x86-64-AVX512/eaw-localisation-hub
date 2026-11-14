param(
    [ValidateSet('english', 'russian')][string]$Language = 'english'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $projectRoot 'node.exe'
$resolver = Join-Path $projectRoot 'apps\agent\src\codex-executable.mjs'

# Probe the same discovery rules Review uses, including an existing npm install.
$probe = "import { pathToFileURL } from 'node:url'; try { (await import(pathToFileURL(process.argv[1]).href)).codexExecutable() } catch { process.exitCode = 1 }"
& $node --input-type=module -e $probe $resolver
if ($LASTEXITCODE -eq 0) { exit 0 }

$winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($winget) {
    try {
        & $winget.Source install --id OpenAI.Codex --exact --source winget --scope user --no-upgrade
        if ($LASTEXITCODE -eq 0) { exit 0 }
    } catch {
        Write-Warning $_.Exception.Message
    }
    # WinGet can return a nonzero exit code for an existing installation.
    & $node --input-type=module -e $probe $resolver
    if ($LASTEXITCODE -eq 0) { exit 0 }
}

Add-Type -AssemblyName System.Windows.Forms
$message = if ($Language -eq 'russian') {
    'Не удалось установить Codex CLI через WinGet. Hub уже установлен. Открыть инструкцию OpenAI по установке Codex?'
} else {
    'Could not install Codex CLI through WinGet. Hub is already installed. Open the OpenAI instructions for installing Codex?'
}
$choice = [System.Windows.Forms.MessageBox]::Show($message, 'EaW Localisation Hub', 'YesNo', 'Information')
if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
    Start-Process -FilePath 'https://learn.chatgpt.com/docs/codex/cli#getting-started'
}
exit 1
