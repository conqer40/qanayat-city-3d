@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not available in PATH.
  echo Please install Node.js, then run this file again.
  pause
  exit /b 1
)

echo Opening Qanayat City...
echo.
echo Checking if the server is already running...

netstat -ano | findstr ":4173" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo Starting server...
  echo A server window will stay open while the system is running.
  echo Close that server window when you want to stop the system.
  echo.
  start "Qanayat City Server" /D "%~dp0" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-server.ps1"
  powershell -NoProfile -Command "Start-Sleep -Seconds 2"
) else (
  echo Server is already running. Opening the system...
)

start "" "http://127.0.0.1:4173"

exit /b 0
