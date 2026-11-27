@echo off
setlocal
if exist "%~dp0node.exe" (
    "%~dp0node.exe" "%~dp0apps\agent\src\cli.mjs" %*
) else (
    node "%~dp0apps\agent\src\cli.mjs" %*
)
exit /b %ERRORLEVEL%
