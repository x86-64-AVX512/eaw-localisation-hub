function Get-EawHubClientStatusMetadata {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $versionPath = Join-Path $ProjectRoot 'VERSION'
    $constantsPath = Join-Path $ProjectRoot 'packages\shared\src\constants.mjs'
    $version = (Get-Content -LiteralPath $versionPath -Raw -Encoding utf8).Trim()
    $constants = Get-Content -LiteralPath $constantsPath -Raw -Encoding utf8
    $protocolMatch = [regex]::Match($constants, 'PROTOCOL_VERSION\s*=\s*(\d+)')
    if ($version -notmatch '^\d+\.\d+\.\d+F\d+$' -or -not $protocolMatch.Success) {
        throw 'Не удалось определить локальную версию клиента или протокола.'
    }
    [pscustomobject]@{
        Version = $version
        Protocol = [int]$protocolMatch.Groups[1].Value
    }
}

function ConvertTo-EawHubVersionParts {
    param([Parameter(Mandatory = $true)][string]$Version)
    $match = [regex]::Match($Version.Trim(), '^(\d+)\.(\d+)\.(\d+)F(\d+)$')
    if (-not $match.Success) { return $null }
    @(
        [int64]$match.Groups[1].Value,
        [int64]$match.Groups[2].Value,
        [int64]$match.Groups[3].Value,
        [int64]$match.Groups[4].Value
    )
}

function Compare-EawHubDisplayVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Installed,
        [Parameter(Mandatory = $true)][string]$Recommended
    )
    $installedParts = ConvertTo-EawHubVersionParts -Version $Installed
    $recommendedParts = ConvertTo-EawHubVersionParts -Version $Recommended
    if ($null -eq $installedParts -or $null -eq $recommendedParts) { return $null }
    for ($index = 0; $index -lt 4; $index++) {
        if ($installedParts[$index] -lt $recommendedParts[$index]) { return -1 }
        if ($installedParts[$index] -gt $recommendedParts[$index]) { return 1 }
    }
    0
}
