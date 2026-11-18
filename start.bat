@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" || exit /b 1

node -e "if (+process.versions.node.split('.')[0] < 24) process.exit(1)" >nul 2>&1
if errorlevel 1 (
    echo [ACPAO] Install Node.js 24 or newer and reopen this window.
    goto :failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ACPAO] npm.cmd was not found on PATH. Reinstall Node.js with npm.
    goto :failed
)

if not exist "node_modules\.bin\vite.cmd" goto :install
if not exist "node_modules\tsx\package.json" goto :install
fc /b "package-lock.json" "node_modules\.acpao-package-lock.json" >nul 2>&1
if not errorlevel 1 goto :build

:install
call npm ci --include=dev
if errorlevel 1 goto :failed
copy /y "package-lock.json" "node_modules\.acpao-package-lock.json" >nul
if errorlevel 1 goto :failed

:build
call npm run build:web
if errorlevel 1 goto :failed
if "%ACPAO_BUILD_GATEWAYS%"=="1" (
    call npm run build:gateway-assets
    if errorlevel 1 goto :failed
)

node --import tsx apps/server/src/main.ts %*
if errorlevel 1 goto :failed
popd
exit /b 0

:failed
echo [ACPAO] Startup failed. Check the message above.
if not defined CI if "%~1"=="" pause
popd
exit /b 1
