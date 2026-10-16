@echo off
title Myth Guard - Game Master
setlocal

:: Use the portable Node.js if this folder was set up with one
set "NODE_DIR=%LOCALAPPDATA%\nodejs-portable\node-v22.16.0-win-x64"
if exist "%NODE_DIR%\node.exe" (
    set "PATH=%NODE_DIR%;%PATH%"
) else (
    where node >nul 2>&1 || (
        echo ERROR: Node.js was not found.
        echo Please install it from https://nodejs.org and run this file again.
        pause
        exit /b 1
    )
)

cd /d "%~dp0"

echo.
echo  =====================================================
echo    MYTH GUARD    -   Game Master's screen
echo  =====================================================
echo.

:: First run: fetch the libraries the app needs
if not exist "node_modules" (
    echo [*] First run - installing, this takes a minute...
    call npm install
    echo.
)

echo [*] Starting the table...
echo.
echo  Open the GM screen at  http://localhost:5173
echo  Your players: use the address printed below, or scan the QR code
echo  inside the app (Table tab, "Invite players").
echo.
echo  If Windows asks, allow Node.js on PRIVATE networks.
echo.
call npm start
pause
