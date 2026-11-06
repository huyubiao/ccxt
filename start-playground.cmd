@echo off
setlocal

pushd "%~dp0docs\playground" || goto :missing_project

set "PLAYGROUND_PORT=3000"
if not "%~1"=="" set "PLAYGROUND_PORT=%~1"

set "PLAYGROUND_NODE=node.exe"
%PLAYGROUND_NODE% -e "process.exit(Number(process.versions.node.split('.')[0]) < 23 ? 1 : 0)" >nul 2>&1
if errorlevel 1 set "PLAYGROUND_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%PLAYGROUND_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) < 23 ? 1 : 0)" >nul 2>&1
if errorlevel 1 (
    echo Node.js 23 or newer is required. Install Node.js LTS and run this script again.
    goto :failed
)

"%PLAYGROUND_NODE%" -e "const port = process.env.PLAYGROUND_PORT; process.exit(/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) < 65536 ? 0 : 1)"
if errorlevel 1 (
    echo Choose a port from 1 to 65535, for example: start-playground.cmd 3001
    goto :failed
)

set "PLAYGROUND_URL=http://127.0.0.1:%PLAYGROUND_PORT%/"
curl.exe --noproxy "*" --fail --silent --max-time 5 "%PLAYGROUND_URL%" 2>nul | findstr /L /C:"<title>CCXT Markets</title>" >nul
if not errorlevel 1 (
    echo CCXT Markets is already running: %PLAYGROUND_URL%
    popd
    pause
    exit /b 0
)

if not exist "node_modules\next\dist\bin\next" (
    echo Installing Playground dependencies...
    call :install_dependencies
    if errorlevel 1 goto :failed
)

echo Open the market lookup after Next.js is ready: %PLAYGROUND_URL%
echo Press Ctrl+C in this window to stop the server.
"%PLAYGROUND_NODE%" "node_modules\next\dist\bin\next" dev --hostname 127.0.0.1 --port %PLAYGROUND_PORT%
if errorlevel 1 goto :failed
popd
exit /b 0

:install_dependencies
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
