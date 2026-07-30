@echo off
REM ====================================================================
REM  Charging Tracker - launcher
REM
REM  Double-click this file to start the dashboard.
REM  Keep the window that opens - closing it stops the dashboard.
REM ====================================================================

setlocal
cd /d "%~dp0"

REM Prefer Node on PATH; fall back to the no-admin portable install.
set "NODE="
where node >nul 2>&1 && set "NODE=node"

if not defined NODE (
  for /d %%D in ("%USERPROFILE%\nodejs\node-v*-win-x64") do (
    if exist "%%D\node.exe" set "NODE=%%D\node.exe"
  )
)

if not defined NODE (
  echo.
  echo   Node.js was not found.
  echo.
  echo   Install it from https://nodejs.org, or if you don't have
  echo   admin rights see the "Node without admin rights" section
  echo   of README.md for the portable setup.
  echo.
  pause
  exit /b 1
)

echo.
echo   Charging Tracker
echo   ----------------
echo   Dashboard : http://localhost:3118
echo.
echo   Your browser will open automatically. You may be asked to
echo   sign in to Garage the first time - you must be on the Tesla
echo   network or VPN.
echo.
echo   KEEP THIS WINDOW OPEN. Closing it stops the dashboard.
echo   Press Ctrl+C to stop.
echo.

REM How charge-complete alerts are delivered.
REM   webhook - POST straight to the Power Automate flow URL. This is the
REM             normal path and it works.
REM   outlook - fallback that sends via the local Outlook client, for a flow
REM             triggered by "When a new email arrives". Only needed if the
REM             flow URL is unavailable. See README.
set "ALERT_TRANSPORT=webhook"

REM Which Garage environment to start in. Leave this commented out for the
REM normal case - the dashboard remembers whichever one you last picked in
REM Admin, and the Production / Engineering switch stays available.
REM
REM Uncomment to PIN one environment. The switch is then disabled in the UI
REM and the admin panel says why. Useful if this copy should only ever be
REM allowed to touch engineering.
REM   set "GARAGE_ENV=prod"
REM   set "GARAGE_ENV=eng"

"%NODE%" server.js

echo.
echo   Dashboard stopped.
pause
