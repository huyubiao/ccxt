@echo off
setlocal DisableDelayedExpansion

pushd "%~dp0docs\playground" || goto :missing_project

set "PLAYGROUND_PORT=3000"
set "PLAYGROUND_NODE_MIN=24"
if not "%~1"=="" set "PLAYGROUND_PORT=%~1"
if /i "%~1"=="rust" (
    set "PLAYGROUND_PORT=3000"
    if not "%~2"=="" set "PLAYGROUND_PORT=%~2"
)

if exist "runtime\node\node.exe" (
    set "PLAYGROUND_NODE=%CD%\runtime\node\node.exe"
    call :check_node
    if not errorlevel 1 goto :node_ready
)
set "PLAYGROUND_NODE=node.exe"
call :check_node
if not errorlevel 1 goto :node_ready
set "PLAYGROUND_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
call :check_node
if errorlevel 1 (
    echo Install Node.js %PLAYGROUND_NODE_MIN% or newer, or extract the Windows Node.js distribution into docs\playground\runtime\node.
    goto :failed
)

:node_ready
if /i "%PLAYGROUND_NODE%"=="%CD%\runtime\node\node.exe" set "PATH=%CD%\runtime\node;%PATH%"
"%PLAYGROUND_NODE%" -e "const port = process.env.PLAYGROUND_PORT; process.exit(/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) < 65536 ? 0 : 1)"
if errorlevel 1 (
    echo Choose a port from 1 to 65535, for example: start-playground.cmd 3001
    goto :failed
)

set "PLAYGROUND_URL=http://127.0.0.1:%PLAYGROUND_PORT%/"
curl.exe --noproxy "*" --fail --silent --max-time 5 "%PLAYGROUND_URL%" 2>nul | findstr /L /C:"<title>CCXT Markets</title>" >nul
if not errorlevel 1 (
    echo CCXT Markets is already running. Reopen %PLAYGROUND_URL% to manage monitoring.
    goto :failed
)

call :configure_proxy

if not exist "node_modules\next\dist\bin\next" (
    echo Installing Playground dependencies...
    call :install_dependencies
    if errorlevel 1 goto :failed
)

echo Open the market lookup after Next.js is ready: %PLAYGROUND_URL%
echo Enable or disable monitoring on the market page. Closing the browser keeps the saved monitoring rule active.
echo Press Ctrl+C in this window to stop the server.
"%PLAYGROUND_NODE%" "scripts\start-rust-markets.mjs"
if errorlevel 1 goto :failed
popd
exit /b 0

:check_node
"%PLAYGROUND_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) < %PLAYGROUND_NODE_MIN% ? 1 : 0)" >nul 2>&1
exit /b

:configure_proxy
rem Preserve explicit proxy settings. Windows environment variable names are case-insensitive.
if defined HTTPS_PROXY exit /b 0
if defined HTTP_PROXY exit /b 0
for /f "delims=" %%P in ('powershell.exe -NoProfile -Command "$settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue; if ($settings.ProxyEnable -eq 1) { $server = $settings.ProxyServer; if ($server -match '(?:^|;)https=([^;]+)') { $server = $Matches[1] }; if ($server -match '^(?:http://)?((?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5})$') { 'http://' + $Matches[1] } }"') do set "HTTPS_PROXY=%%P"
if not defined HTTPS_PROXY exit /b 0
if not defined NO_PROXY set "NO_PROXY=localhost,127.0.0.1,::1"
echo Using the Windows system proxy for outbound HTTPS requests.
exit /b 0

:install_dependencies
if /i "%PLAYGROUND_NODE%"=="%CD%\runtime\node\node.exe" if exist "runtime\node\node_modules\npm\bin\npm-cli.js" (
    "%PLAYGROUND_NODE%" "runtime\node\node_modules\npm\bin\npm-cli.js" ci
    exit /b
)
if exist "runtime\windows-npm\bin\npm-cli.js" (
    "%PLAYGROUND_NODE%" "runtime\windows-npm\bin\npm-cli.js" ci
    exit /b
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo npm is required to install dependencies. Install Node.js LTS with npm.
    exit /b 1
)
call npm.cmd ci
exit /b

:failed
popd
echo CCXT Markets did not start. Check the error above.
pause
exit /b 1

:missing_project
echo Could not find docs\playground next to this script.
pause
exit /b 1
