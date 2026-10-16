@echo off
title Myth Guard - development server
set "NODE_DIR=%LOCALAPPDATA%\nodejs-portable\node-v22.16.0-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
cd /d "%~dp0"
if not exist "node_modules" call npm install
echo Development server with live reload (slower for players than START.bat).
echo It listens on this computer only. To let phones in, start it as: START-DEV.bat --lan
call npm run dev -- %*
pause
