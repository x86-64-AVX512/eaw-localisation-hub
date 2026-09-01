param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'hash-utils.ps1')
$version = '1.0.4129.50'
$expectedHash = 'D3934F482D484B89FB4825DF720C710664E1143A1E90F7B3A60794EF33F473D2'
$toolsRoot = Join-Path $projectRoot '.tools\webview2'
$packagePath = Join-Path $toolsRoot "Microsoft.Web.WebView2.$version.nupkg"
$sdkRoot = Join-Path $toolsRoot "sdk-$version"
$zig = Join-Path $projectRoot '.tools\zig-extract\zig-windows-x86_64-0.13.0\zig.exe'
$outputRoot = Join-Path $projectRoot 'dist\EawReview'

if (-not (Test-Path -LiteralPath $zig -PathType Leaf)) {
    throw 'Zig toolchain is missing. Run scripts\bootstrap-zig.ps1 first.'
}
New-Item -ItemType Directory -Force -Path $toolsRoot, $outputRoot | Out-Null
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    Invoke-WebRequest -UseBasicParsing `
        -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" `
        -OutFile $packagePath
}
$actualHash = Get-EawFileSha256 -LiteralPath $packagePath
if ($actualHash -ne $expectedHash) {
    throw "WebView2 SDK checksum mismatch: $actualHash"
}
if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot 'build\native\include\WebView2.h'))) {
    if (Test-Path -LiteralPath $sdkRoot) { Remove-Item -LiteralPath $sdkRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $sdkRoot | Out-Null
    & tar.exe -xf $packagePath -C $sdkRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the WebView2 SDK package.' }
}

$include = Join-Path $sdkRoot 'build\native\include'
$source = Join-Path $projectRoot 'apps\review-host\src\main.cpp'
$output = Join-Path $outputRoot 'EaWReview.exe'
& $zig c++ $source `
    -target x86_64-windows-gnu `
    -std=c++20 -O1 -DUNICODE -D_UNICODE -fms-extensions -municode `
    -I $include `
    -lole32 -loleaut32 -luuid -luser32 -lshell32 -static `
    '-Wl,--subsystem,windows' `
    -o $output
if ($LASTEXITCODE -ne 0) { throw 'Could not build EaWReview.exe.' }
Copy-Item -LiteralPath (Join-Path $sdkRoot 'build\native\x64\WebView2Loader.dll') `
    -Destination (Join-Path $outputRoot 'WebView2Loader.dll') -Force
Write-Output "[review-host] $output"
