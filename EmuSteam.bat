@echo off
rem Double-click launcher for Windows. Keeps the console around so that a
rem missing Node install or a startup error is actually readable.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   EmuSteam needs Node.js 20 or newer.
  echo   Install it from https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)

node "src\main.mjs" %*
if errorlevel 1 (
  echo.
  echo   EmuSteam exited with an error. The message above says why.
  pause
)
