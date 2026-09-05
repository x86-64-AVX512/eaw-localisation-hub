$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'agent-status.ps1')

$metadata = Get-EawHubClientStatusMetadata -ProjectRoot $projectRoot
if ($metadata.Protocol -ne 15) { throw "Unexpected protocol: $($metadata.Protocol)" }
if ((Compare-EawHubDisplayVersion -Installed '0.8.4F2' -Recommended '0.8.7F1') -ne -1) {
    throw 'Version comparison did not detect an update.'
}
if ((Compare-EawHubDisplayVersion -Installed '0.8.7F1' -Recommended '0.7.0F1') -ne 1) {
    throw 'Version comparison did not detect a newer client fix level.'
}
if ((Compare-EawHubDisplayVersion -Installed '0.8.7F1' -Recommended '0.8.7F1') -ne 0) {
    throw 'Equal versions must compare as equal.'
}
if ($null -ne (Compare-EawHubDisplayVersion -Installed 'broken' -Recommended '0.8.7F1')) {
    throw 'Malformed versions must not be ordered.'
}
Write-Output "[agent-status-smoke] local=$($metadata.Version), protocol=$($metadata.Protocol)"
