@echo off
rem One-time: creates a desktop shortcut for the app.
rem IMPORTANT: keep this file ASCII-only. cmd.exe parses batch content with the
rem console codepage and non-ASCII inside command arguments is unreliable
rem (v1 failed exactly because of Chinese in the powershell -Command string).
rem All Chinese text lives in scripts/make-shortcut.ps1 (UTF-8 with BOM).
title Create desktop shortcut
cd /d "%~dp0"
if not exist "scripts\make-shortcut.ps1" (
  echo [Error] scripts\make-shortcut.ps1 not found.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\make-shortcut.ps1"
if errorlevel 1 (
  echo.
  echo [Error] Shortcut creation failed. Manual fallback:
  echo   This folder is now open in Explorer - right-click the launcher .bat
  echo   and choose: Send to - Desktop (create shortcut)
  explorer "%~dp0"
  pause
  exit /b 1
)
timeout /t 5 >nul
